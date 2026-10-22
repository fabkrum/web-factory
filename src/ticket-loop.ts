import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentCli, SessionResult } from "./agent-cli.ts";
import type { SiteConfig } from "./config.ts";
import { runGate, type GateResult } from "./gate.ts";
import { branchExists, git, gitSucceeds, worktreeOf } from "./git.ts";
import { stageLabel } from "./stages.ts";
import type { Issue, Tracker } from "./tracker.ts";

/** Local, uncommitted Factory state in the Site repository: worktrees for now. */
const LOCAL_DIR = ".factory";

export interface LoopOptions {
  siteDir: string;
  spec: number;
  config: SiteConfig;
  agentCli: AgentCli;
  tracker: Tracker;
  log: (line: string) => void;
}

export interface LoopResult {
  passed: number[];
  notPassed: number[];
}

/** A reason the loop cannot run at all, said in plain words. */
export class LoopError extends Error {}

export const integrationBranch = (spec: number): string => `spec/${spec}`;
export const ticketBranch = (ticket: number): string => `ticket/${ticket}`;

export async function runTicketLoop(options: LoopOptions): Promise<LoopResult> {
  const { siteDir, spec, config, tracker, log } = options;
  if (!(await gitSucceeds(siteDir, "rev-parse", "--is-inside-work-tree"))) {
    throw new LoopError("This Site folder is not a git repository, so the Ticket loop has nowhere to build.");
  }
  if (!(await branchExists(siteDir, config.baseBranch))) {
    throw new LoopError(`The base branch ${config.baseBranch} does not exist in this Site repository.`);
  }

  const tickets = (await tracker.ticketsOf(spec))
    .filter((ticket) => ticket.state === "open" && ticket.labels.includes(stageLabel("build")))
    .sort((a, b) => a.number - b.number);
  if (tickets.length === 0) {
    log(`Spec #${spec} has no open Tickets in the Build Stage, so there is nothing to build.`);
    return { passed: [], notPassed: [] };
  }

  await keepLocalStateOutOfGit(siteDir);
  const integration = integrationBranch(spec);
  if (!(await branchExists(siteDir, integration))) {
    await git(siteDir, "branch", integration, config.baseBranch);
  }

  const result: LoopResult = { passed: [], notPassed: [] };
  for (const ticket of tickets) {
    const passed = await buildTicket(ticket, options);
    (passed ? result.passed : result.notPassed).push(ticket.number);
  }
  return result;
}

async function buildTicket(ticket: Issue, options: LoopOptions): Promise<boolean> {
  const { siteDir, spec, config, agentCli, tracker, log } = options;
  const integration = integrationBranch(spec);
  const branch = ticketBranch(ticket.number);
  const worktree = await openWorktree(siteDir, ticket.number, integration);
  const base = await git(siteDir, "rev-parse", integration);
  log(`Ticket #${ticket.number}: building on ${branch} in ${relative(siteDir, worktree)}`);

  const session = await agentCli.runSession({
    cwd: worktree,
    prompt: buildPrompt(ticket, spec, config),
    sandbox: true,
    timeoutMs: config.sessionTimeoutMs,
  });
  const gate = await judge(session, worktree, base, config.testCommand);

  if (!gate.passed) {
    log(`Ticket #${ticket.number}: not passed. ${firstLine(gate.reason)}`);
    await tracker.comment(
      ticket.number,
      `Not passed yet. ${gate.reason}\n\nThe work so far stays on \`${branch}\` in \`${relative(siteDir, worktree)}\`.`,
    );
    return false;
  }

  const head = await fastForward(siteDir, integration, base, branch);
  await git(siteDir, "worktree", "remove", worktree);
  await tracker.comment(
    ticket.number,
    `Pass. The Ticket loop built this Ticket on \`${branch}\`, its gate was green, and \`${integration}\` now contains it (${head.slice(0, 7)}).`,
  );
  await tracker.close(ticket.number);
  log(`Ticket #${ticket.number}: Pass, now in ${integration}`);
  return true;
}

async function judge(session: SessionResult, worktree: string, base: string, testCommand: string): Promise<GateResult> {
  switch (session.kind) {
    case "done":
      return runGate(worktree, base, testCommand);
    case "failed":
      return { passed: false, reason: `The Build session failed: ${session.reason}` };
    case "rate-limited":
      return { passed: false, reason: `The Agent CLI hit its rate limit until ${session.until.toISOString()}.` };
    case "decision":
      return { passed: false, reason: `The Build session needs a decision: ${session.question}` };
  }
}

/** One worktree per Ticket, on the Ticket's own branch, cut from the Spec's integration branch. */
async function openWorktree(siteDir: string, ticket: number, integration: string): Promise<string> {
  const branch = ticketBranch(ticket);
  const checkedOut = await worktreeOf(siteDir, branch);
  if (checkedOut) return checkedOut;
  const path = join(siteDir, LOCAL_DIR, "worktrees", `ticket-${ticket}`);
  if (existsSync(path)) {
    throw new LoopError(`${relative(siteDir, path)} exists but is not the worktree of ${branch}. Move it away and run the loop again.`);
  }
  await mkdir(join(siteDir, LOCAL_DIR, "worktrees"), { recursive: true });
  if (await branchExists(siteDir, branch)) {
    await git(siteDir, "worktree", "add", "--quiet", path, branch);
  } else {
    await git(siteDir, "worktree", "add", "--quiet", "-b", branch, path, integration);
  }
  return path;
}

/** Moves the integration branch to the Ticket's head, only if that is a fast-forward. */
async function fastForward(siteDir: string, integration: string, base: string, branch: string): Promise<string> {
  const head = await git(siteDir, "rev-parse", branch);
  if (!(await gitSucceeds(siteDir, "merge-base", "--is-ancestor", base, head))) {
    throw new LoopError(`${branch} does not build on ${integration}, so it cannot be fast-forwarded into it.`);
  }
  if (await worktreeOf(siteDir, integration)) {
    throw new LoopError(`${integration} is checked out in a worktree, so the Ticket loop will not move it. Switch that worktree to another branch.`);
  }
  await git(siteDir, "update-ref", `refs/heads/${integration}`, head, base);
  return head;
}

/** Keeps `.factory/` out of `git status` without touching any committed file. */
async function keepLocalStateOutOfGit(siteDir: string): Promise<void> {
  const commonDir = await git(siteDir, "rev-parse", "--git-common-dir");
  const info = join(isAbsolute(commonDir) ? commonDir : join(siteDir, commonDir), "info");
  const exclude = join(info, "exclude");
  const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (current.split("\n").includes(`/${LOCAL_DIR}/`)) return;
  await mkdir(info, { recursive: true });
  await appendFile(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}/${LOCAL_DIR}/\n`);
}

function buildPrompt(ticket: Issue, spec: number, config: SiteConfig): string {
  return [
    `You are building Ticket #${ticket.number} of Spec #${spec} in this Site's repository, unattended.`,
    "",
    `# ${ticket.title}`,
    "",
    ticket.body,
    "",
    "Commit your work to the current branch and leave no uncommitted files.",
    `The Site's test command \`${config.testCommand}\` must be green.`,
  ].join("\n");
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

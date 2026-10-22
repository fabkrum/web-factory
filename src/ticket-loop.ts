import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentCli, SessionResult } from "./agent-cli.ts";
import type { SiteConfig } from "./config.ts";
import { runGate, type GateResult } from "./gate.ts";
import { branchExists, git, gitSucceeds, worktreeOf } from "./git.ts";
import { stageLabel } from "./stages.ts";
import type { Issue, IssueEvent, Tracker } from "./tracker.ts";

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

  // A Pass that broke off is finished from the tracker and git, never from a local record alone:
  // anything that happened on the Ticket since, or a new commit on its branch, is rework.
  const history = await tracker.historyOf(ticket.number);
  const tip = await refTarget(siteDir, `refs/heads/${branch}`);
  const announced = announcedPass(history);
  if (announced && announced === tip && (await gitSucceeds(siteDir, "merge-base", "--is-ancestor", announced, integration))) {
    log(`Ticket #${ticket.number}: its Pass was announced last run but the Ticket did not close, closing it`);
    await git(siteDir, "update-ref", "-d", passRef(ticket.number));
    await closeAsPass(ticket, options);
    return true;
  }
  const tested = await refTarget(siteDir, passRef(ticket.number));
  if (tested) {
    if (tested === tip && !passCommits(history).includes(tested)) {
      log(`Ticket #${ticket.number}: its Pass broke off last run, finishing it`);
      return finishPass(ticket, options, tested);
    }
    await git(siteDir, "update-ref", "-d", passRef(ticket.number));
  }

  const worktree = await openWorktree(siteDir, ticket.number, integration);
  const catchUp = await catchUpWith(worktree, integration);
  const base = await git(siteDir, "rev-parse", integration);
  log(`Ticket #${ticket.number}: building on ${branch} in ${relative(siteDir, worktree)}`);

  const session = await agentCli.runSession({
    cwd: worktree,
    prompt: buildPrompt(ticket, spec, config, catchUp),
    sandbox: true,
    timeoutMs: config.sessionTimeoutMs,
  });
  const gate = await judge(session, worktree, base, branch, integration, config.testCommand);

  if (!gate.passed) {
    log(`Ticket #${ticket.number}: not passed. ${firstLine(gate.reason)}`);
    await tracker.comment(
      ticket.number,
      `Not passed yet. ${gate.reason}\n\nThe work so far stays on \`${branch}\` in \`${relative(siteDir, worktree)}\`.`,
    );
    return false;
  }

  // Recorded before anything moves, so a run that dies before the Pass comment finishes it next time.
  await git(siteDir, "update-ref", passRef(ticket.number), gate.head);
  return finishPass(ticket, options, gate.head);
}

/** Where a green gate leaves the commit it tested until the Pass comment is posted. */
const passRef = (ticket: number): string => `refs/factory/pass/ticket-${ticket}`;

const PASS_COMMENT = /^Pass\.[\s\S]*\(([0-9a-f]{40})\)\.$/;

/** The commits the Ticket's Pass comments name, oldest first. */
function passCommits(history: IssueEvent[]): string[] {
  return history.flatMap((event) => (event.kind === "comment" ? (PASS_COMMENT.exec(event.body)?.[1] ?? []) : []));
}

/** The commit of a Pass that was announced and is the last thing that happened on the Ticket. */
function announcedPass(history: IssueEvent[]): string | undefined {
  const last = history.at(-1);
  return last?.kind === "comment" ? PASS_COMMENT.exec(last.body)?.[1] : undefined;
}

async function refTarget(siteDir: string, ref: string): Promise<string | undefined> {
  if (!(await gitSucceeds(siteDir, "rev-parse", "--verify", "--quiet", ref))) return undefined;
  return git(siteDir, "rev-parse", ref);
}

/**
 * The steps of a Pass after the gate: merge the tested commit, remove the worktree,
 * comment, close. A rerun repeats the merge and the worktree removal harmlessly.
 * Once the Pass comment is posted it is the record: the pass ref goes, and a rerun
 * that finds the comment last on the open Ticket only closes it.
 */
async function finishPass(ticket: Issue, options: LoopOptions, head: string): Promise<boolean> {
  const { siteDir, spec, tracker, log } = options;
  const integration = integrationBranch(spec);
  const branch = ticketBranch(ticket.number);

  if (!(await gitSucceeds(siteDir, "merge-base", "--is-ancestor", head, integration))) {
    const tip = await git(siteDir, "rev-parse", integration);
    if (!(await gitSucceeds(siteDir, "merge-base", "--is-ancestor", tip, head))) {
      // Nothing a rerun of this Pass can fix, so the Ticket goes back to Build.
      await git(siteDir, "update-ref", "-d", passRef(ticket.number));
      const worktree = await worktreeOf(siteDir, branch);
      const reason = `\`${integration}\` moved on since the gate tested ${head.slice(0, 7)}, and \`${branch}\` does not build on it, so it cannot be fast-forwarded.`;
      log(`Ticket #${ticket.number}: not passed. ${reason}`);
      await tracker.comment(
        ticket.number,
        `Not passed yet. ${reason}\n\nThe work so far stays on \`${branch}\`${worktree ? ` in \`${relative(siteDir, worktree)}\`` : ""}.`,
      );
      return false;
    }
    await fastForward(siteDir, integration, tip, head);
  }
  const worktree = await worktreeOf(siteDir, branch);
  // The tested commit is in the integration branch now, so whatever the tests left behind may go.
  if (worktree) await git(siteDir, "worktree", "remove", "--force", worktree);
  await tracker.comment(
    ticket.number,
    `Pass. The Ticket loop built this Ticket on \`${branch}\`, its gate was green, and \`${integration}\` now contains it (${head}).`,
  );
  await git(siteDir, "update-ref", "-d", passRef(ticket.number));
  await closeAsPass(ticket, options);
  return true;
}

/** Closes the Ticket of an announced Pass. */
async function closeAsPass(ticket: Issue, options: LoopOptions): Promise<void> {
  const { spec, tracker, log } = options;
  await tracker.close(ticket.number);
  log(`Ticket #${ticket.number}: Pass, now in ${integrationBranch(spec)}`);
}

async function judge(
  session: SessionResult,
  worktree: string,
  base: string,
  branch: string,
  integration: string,
  testCommand: string,
): Promise<GateResult> {
  switch (session.kind) {
    case "done":
      return runGate(worktree, base, branch, integration, testCommand);
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

/**
 * Brings the Ticket's branch up to the integration branch, so work from an earlier
 * run builds on what has Passed since. Fast-forwards when it can, whatever the Site's
 * `merge.ff` says, so a branch with no work of its own gains no merge commit.
 * Says what the session must finish when the merge did not.
 */
async function catchUpWith(worktree: string, integration: string): Promise<string | undefined> {
  if (await gitSucceeds(worktree, "merge-base", "--is-ancestor", integration, "HEAD")) return undefined;
  if (await gitSucceeds(worktree, "merge", "--quiet", "--no-edit", "--ff", integration)) return undefined;
  if (await gitSucceeds(worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")) {
    return `Merging \`${integration}\` into this branch left conflicts. Resolve them and commit the merge before anything else.`;
  }
  return `\`${integration}\` moved on and could not be merged into this branch. Merge it first.`;
}

/** Moves the integration branch from its tip to the commit the gate tested, which builds on that tip. */
async function fastForward(siteDir: string, integration: string, tip: string, head: string): Promise<void> {
  if (await worktreeOf(siteDir, integration)) {
    throw new LoopError(`${integration} is checked out in a worktree, so the Ticket loop will not move it. Switch that worktree to another branch.`);
  }
  await git(siteDir, "update-ref", `refs/heads/${integration}`, head, tip);
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

function buildPrompt(ticket: Issue, spec: number, config: SiteConfig, catchUp: string | undefined): string {
  return [
    ...(catchUp ? [catchUp, ""] : []),
    `You are building Ticket #${ticket.number} of Spec #${spec} in this Site's repository, unattended.`,
    "",
    `# ${ticket.title}`,
    "",
    ticket.body,
    "",
    "Commit your work to the current branch and leave no uncommitted files.",
    `The work must build on \`${integrationBranch(spec)}\`: the current branch contains it, so never rebase or reset it away.`,
    `The Site's test command \`${config.testCommand}\` must be green.`,
  ].join("\n");
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

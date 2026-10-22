import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SiteConfig } from "./config.ts";
import { runGate } from "./gate.ts";
import { branchExists, git, gitSucceeds, worktreeOf } from "./git.ts";
import { recordTicketState, type TicketState } from "./loop-state.ts";
import { stageLabel } from "./stages.ts";
import type { AgentCli } from "./agent-cli.ts";
import type { Issue, IssueEvent, Tracker } from "./tracker.ts";

/** Local, uncommitted Factory state in the Site repository: worktrees and the loop's state per Spec. */
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
  /** Waiting for the Builder, with the reason on the Ticket. */
  parked: number[];
  notPassed: number[];
}

type Outcome = "passed" | "parked" | "not-passed";

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
    return { passed: [], parked: [], notPassed: [] };
  }

  await keepLocalStateOutOfGit(siteDir);
  const integration = integrationBranch(spec);
  if (!(await branchExists(siteDir, integration))) {
    await git(siteDir, "branch", integration, config.baseBranch);
  }

  const result: LoopResult = { passed: [], parked: [], notPassed: [] };
  for (const ticket of tickets) {
    const outcome = await buildTicket(ticket, options);
    ({ passed: result.passed, parked: result.parked, "not-passed": result.notPassed })[outcome].push(ticket.number);
  }
  return result;
}

async function buildTicket(ticket: Issue, options: LoopOptions): Promise<Outcome> {
  const { siteDir, spec, config, agentCli, log } = options;
  const integration = integrationBranch(spec);
  const branch = ticketBranch(ticket.number);

  // A Pass that broke off is finished from the tracker and git, never from a local record alone:
  // anything that happened on the Ticket since, or a new commit on its branch, is rework.
  const history = await options.tracker.historyOf(ticket.number);
  const tip = await refTarget(siteDir, `refs/heads/${branch}`);
  const announced = announcedPass(history);
  if (announced && announced === tip && (await gitSucceeds(siteDir, "merge-base", "--is-ancestor", announced, integration))) {
    log(`Ticket #${ticket.number}: its Pass was announced last run but the Ticket did not close, closing it`);
    await git(siteDir, "update-ref", "-d", passRef(ticket.number));
    await closeAsPass(ticket, options);
    await record(options, ticket, { status: "passed", attempts: 0 });
    return "passed";
  }

  // A parked Ticket waits for the Builder: until something happens on it after the park comment.
  const parkedFor = stillParked(history);
  if (parkedFor !== undefined) {
    log(`Ticket #${ticket.number}: parked, waiting for you. ${firstLine(parkedFor)}`);
    return "parked";
  }

  const answer = answeredPark(history);
  let previous: string | undefined;
  const tested = await refTarget(siteDir, passRef(ticket.number));
  if (tested) {
    if (tested === tip && !passCommits(history).includes(tested)) {
      log(`Ticket #${ticket.number}: its Pass broke off last run, finishing it`);
      const refused = await finishPass(ticket, options, tested);
      if (refused === undefined) {
        await record(options, ticket, { status: "passed", attempts: 0 });
        return "passed";
      }
      previous = `Your last attempt did not pass: ${refused}`;
    }
    await git(siteDir, "update-ref", "-d", passRef(ticket.number));
  }

  // Every fix round works in the same worktree, so it sees what the attempt before left.
  const worktree = await openWorktree(siteDir, ticket.number, integration);
  let reason = "";
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const catchUp = await catchUpWith(worktree, integration);
    const base = await git(siteDir, "rev-parse", integration);
    log(
      attempt === 1
        ? `Ticket #${ticket.number}: building on ${branch} in ${relative(siteDir, worktree)}`
        : `Ticket #${ticket.number}: fix round ${attempt - 1}, back to Build with the failing reason`,
    );
    await record(options, ticket, { status: "building", attempts: attempt });

    const session = await agentCli.runSession({
      cwd: worktree,
      prompt: buildPrompt(ticket, spec, config, [catchUp, answer, previous]),
      sandbox: true,
      timeoutMs: config.sessionTimeoutMs,
    });

    if (session.kind === "decision") {
      return park(ticket, options, attempt, `The Build session needs a decision from you: ${session.question}`, [
        "The Build session stopped because it needs a decision only you can make:",
        "",
        session.question,
        "",
        `Answer in a comment on this Ticket, then run the Ticket loop again. The work so far stays on \`${branch}\`.`,
      ]);
    }
    if (session.kind === "rate-limited") {
      // Hitting the plan's limit is not the Ticket's failure, so it neither counts as an attempt nor parks.
      reason = `The Agent CLI hit its rate limit until ${session.until.toISOString()}.`;
      log(`Ticket #${ticket.number}: not passed. ${reason}`);
      await options.tracker.comment(ticket.number, `Not passed yet. ${reason}\n\nThe work so far stays on \`${branch}\`.`);
      await record(options, ticket, { status: "not-passed", attempts: attempt, reason });
      return "not-passed";
    }

    const gate =
      session.kind === "failed"
        ? { passed: false as const, reason: `The Build session failed: ${session.reason}` }
        : await runGate(worktree, base, branch, integration, config.testCommand);
    if (gate.passed) {
      // Recorded before anything moves, so a run that dies before the Pass comment finishes it next time.
      await git(siteDir, "update-ref", passRef(ticket.number), gate.head);
      const refused = await finishPass(ticket, options, gate.head);
      if (refused === undefined) {
        await record(options, ticket, { status: "passed", attempts: attempt });
        return "passed";
      }
      reason = refused;
    } else {
      reason = gate.reason;
    }
    log(`Ticket #${ticket.number}: not passed. ${firstLine(reason)}`);
    previous = `Your last attempt did not pass: ${reason}\n\nFix exactly that.`;
  }

  return park(ticket, options, config.maxAttempts, reason, [
    `The Ticket loop tried this Ticket ${config.maxAttempts} times and it did not pass. The last reason:`,
    "",
    reason,
    "",
    `The work so far stays on \`${branch}\` in \`${relative(siteDir, worktree)}\`. ` +
      "Say in a comment on this Ticket what should change, then run the Ticket loop again.",
  ]);
}

/** Leaves the Ticket open in its Stage, says why on it, and marks it parked for the board. */
async function park(ticket: Issue, options: LoopOptions, attempts: number, reason: string, comment: string[]): Promise<Outcome> {
  options.log(`Ticket #${ticket.number}: parked. ${firstLine(reason)}`);
  await options.tracker.comment(ticket.number, `${PARKED} ${comment.join("\n")}`);
  await record(options, ticket, { status: "parked", attempts, reason });
  return "parked";
}

async function record(options: LoopOptions, ticket: Issue, state: TicketState): Promise<void> {
  await recordTicketState(join(options.siteDir, LOCAL_DIR), options.spec, ticket.number, state);
}

const PARKED = "Parked.";

/** The park comment, when it is the last thing that happened on the Ticket. */
function stillParked(history: IssueEvent[]): string | undefined {
  const last = history.at(-1);
  return last?.kind === "comment" && last.body.startsWith(PARKED) ? last.body.slice(PARKED.length).trim() : undefined;
}

/** What the session needs to know when the Builder answered a park: the park comment and everything said since. */
function answeredPark(history: IssueEvent[]): string | undefined {
  const at = history.findLastIndex((event) => event.kind === "comment" && event.body.startsWith(PARKED));
  if (at === -1) return undefined;
  const since = history.slice(at + 1).flatMap((event) => (event.kind === "comment" ? [event.body] : []));
  // A Pass since the park settled it; what came after is not an answer to it.
  if (since.length === 0 || since.some((body) => PASS_COMMENT.test(body))) return undefined;
  const parked = history[at] as { body: string };
  return [
    "This Ticket was parked last time, with this on the Ticket:",
    "",
    parked.body,
    "",
    "The Builder answered since. Build exactly what the answer says:",
    "",
    ...since,
  ].join("\n");
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
 * comment, close. Returns why it could not, when the integration branch moved on. A rerun repeats the merge and the worktree removal harmlessly.
 * Once the Pass comment is posted it is the record: the pass ref goes, and a rerun
 * that finds the comment last on the open Ticket only closes it.
 */
async function finishPass(ticket: Issue, options: LoopOptions, head: string): Promise<string | undefined> {
  const { siteDir, spec, tracker } = options;
  const integration = integrationBranch(spec);
  const branch = ticketBranch(ticket.number);

  if (!(await gitSucceeds(siteDir, "merge-base", "--is-ancestor", head, integration))) {
    const tip = await git(siteDir, "rev-parse", integration);
    if (!(await gitSucceeds(siteDir, "merge-base", "--is-ancestor", tip, head))) {
      // Nothing a rerun of this Pass can fix, so the Ticket goes back to Build.
      await git(siteDir, "update-ref", "-d", passRef(ticket.number));
      return `\`${integration}\` moved on since the gate tested ${head.slice(0, 7)}, and \`${branch}\` does not build on it, so it cannot be fast-forwarded.`;
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
  return undefined;
}

/** Closes the Ticket of an announced Pass. */
async function closeAsPass(ticket: Issue, options: LoopOptions): Promise<void> {
  const { spec, tracker, log } = options;
  await tracker.close(ticket.number);
  log(`Ticket #${ticket.number}: Pass, now in ${integrationBranch(spec)}`);
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

/** The Ticket, preceded by what this attempt must handle first: a catch-up, the Builder's answer, the last failure. */
function buildPrompt(ticket: Issue, spec: number, config: SiteConfig, first: (string | undefined)[]): string {
  return [
    ...first.flatMap((note) => (note ? [note, ""] : [])),
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

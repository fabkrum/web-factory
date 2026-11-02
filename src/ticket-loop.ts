import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { clearCodeReview, codeReviewComment, codeReviewPrompt, isCodeReviewComment, numberedPoints, takeCodeReview } from "./code-review.ts";
import type { SiteConfig } from "./config.ts";
import { runGate } from "./gate.ts";
import { branchExists, git, gitSucceeds, worktreeOf } from "./git.ts";
import { LOCAL_DIR, recordTicketState, type TicketState } from "./loop-state.ts";
import { couldNotRun, formatFailures } from "./review/report.ts";
import type { ReviewReport } from "./review/review.ts";
import { ServeError, withServedBuild } from "./served-build.ts";
import { stageLabel } from "./stages.ts";
import type { AgentCli } from "./agent-cli.ts";
import type { Clock } from "./clock.ts";
import type { Host } from "./host.ts";
import type { Issue, IssueEvent, PullRequest, Tracker } from "./tracker.ts";

/** Runs the Review checks on the Site served at `url`, whose repository is `repo`. */
export type ReviewSite = (url: URL, repo: string) => Promise<ReviewReport>;

export interface LoopOptions {
  siteDir: string;
  spec: number;
  config: SiteConfig;
  agentCli: AgentCli;
  tracker: Tracker;
  host: Host;
  clock: Clock;
  reviewSite: ReviewSite;
  log: (line: string) => void;
}

export interface LoopResult {
  passed: number[];
  /** Waiting for the Builder, with the reason on the Ticket. */
  parked: number[];
  notPassed: number[];
  /** Never started, because a blocker did not Pass; the reason is in the loop's local state. */
  blocked: { ticket: number; reason: string }[];
  /** The Spec's pull request, once every Ticket of the Spec has Passed. */
  pullRequest?: SpecPullRequest;
}

export interface SpecPullRequest extends PullRequest {
  /** The Preview URL from the host, or undefined when an earlier run's Preview still shows this pull request. */
  preview?: string;
  opened: boolean;
}

type Outcome = "passed" | "parked" | "not-passed";

/** A reason the loop cannot run at all, said in plain words. */
export class LoopError extends Error {}

/** How long the loop waits when a rate limit reports a time that has already passed, so it never retries in a tight loop. */
const MIN_RATE_LIMIT_WAIT_MS = 60 * 1000;

/** The remote the Spec's integration branch is pushed to for its pull request. */
const REMOTE = "origin";

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
  if (integrationBranch(spec) === config.baseBranch) {
    throw new LoopError(`The base branch ${config.baseBranch} is also the Spec's integration branch, and the Ticket loop never moves the base branch.`);
  }

  const all = await tracker.ticketsOf(spec);
  const tickets = all
    .filter((ticket) => ticket.state === "open" && ticket.labels.includes(stageLabel("build")))
    .sort((a, b) => a.number - b.number);
  const result: LoopResult = { passed: [], parked: [], notPassed: [], blocked: [] };
  if (tickets.length === 0 && !specDone(all)) {
    log(`Spec #${spec} has no open Tickets in the Build Stage, so there is nothing to build. Tickets reach it once the Builder approves the Design.`);
    return result;
  }

  if (tickets.length > 0 && !config.serveCommand) {
    throw new LoopError(
      "factory.json has no serveCommand, so the Ticket loop cannot serve a Ticket's build to its Review checks, and without them no Ticket can Pass. Add the command that serves your Site to factory.json, then run the loop again.",
    );
  }

  await keepLocalStateOutOfGit(siteDir);
  const integration = integrationBranch(spec);
  if (!(await branchExists(siteDir, integration))) {
    await git(siteDir, "branch", integration, config.baseBranch);
  }

  // Lowest unblocked Ticket first, looking again after every Ticket: a Pass may unblock a lower one.
  const outcomes = new Map<number, Outcome>();
  const states = new Map(all.map((ticket) => [ticket.number, ticket.state]));
  const pending = [...tickets];
  for (;;) {
    const next = await firstUnblocked(pending, states, options);
    if (!next) break;
    pending.splice(pending.indexOf(next), 1);
    const outcome = await buildTicket(next, options);
    outcomes.set(next.number, outcome);
    if (outcome === "passed") states.set(next.number, "closed");
    ({ passed: result.passed, parked: result.parked, "not-passed": result.notPassed })[outcome].push(next.number);
  }
  for (const ticket of pending) {
    const reason = await whyBlocked(ticket, pending, outcomes, states, options);
    log(`Ticket #${ticket.number}: not started. ${reason}`);
    await record(options, ticket, { status: "blocked", attempts: 0, reason });
    result.blocked.push({ ticket: ticket.number, reason });
  }

  if (specDone(await tracker.ticketsOf(spec))) {
    result.pullRequest = await openSpecPullRequest(options);
  }
  return result;
}

function specDone(tickets: Issue[]): boolean {
  return tickets.length > 0 && tickets.every((ticket) => ticket.state === "closed");
}

/** The lowest pending Ticket whose blockers are all closed, which for a Ticket of the Spec means it Passed. */
async function firstUnblocked(pending: Issue[], states: Map<number, Issue["state"]>, options: LoopOptions): Promise<Issue | undefined> {
  for (const ticket of pending) {
    let unblocked = true;
    for (const blocker of ticket.blockedBy) {
      if ((await stateOf(blocker, states, options)) !== "closed") {
        unblocked = false;
        break;
      }
    }
    if (unblocked) return ticket;
  }
  return undefined;
}

/** A blocker's state: known for the Spec's Tickets, looked up once for any other issue. */
async function stateOf(issue: number, states: Map<number, Issue["state"]>, options: LoopOptions): Promise<Issue["state"]> {
  let state = states.get(issue);
  if (state === undefined) {
    state = (await options.tracker.getIssue(issue)).state;
    states.set(issue, state);
  }
  return state;
}

/** Why a Ticket was never started, naming its first blocker that is still open. */
async function whyBlocked(
  ticket: Issue,
  pending: Issue[],
  outcomes: Map<number, Outcome>,
  states: Map<number, Issue["state"]>,
  options: LoopOptions,
): Promise<string> {
  for (const blocker of ticket.blockedBy) {
    if ((await stateOf(blocker, states, options)) === "closed") continue;
    const outcome = outcomes.get(blocker);
    const waits = `It waits for #${blocker}`;
    if (outcome === "parked") return `${waits}, which is parked and waiting for you. Once #${blocker} passes, the Ticket loop builds this one.`;
    if (outcome === "not-passed") return `${waits}, which did not pass. Once #${blocker} passes, the Ticket loop builds this one.`;
    if (pending.some((other) => other.number === blocker)) {
      return `${waits}, which is itself waiting for a blocker. Once #${blocker} passes, the Ticket loop builds this one.`;
    }
    return `${waits}, which is still open and is not a Ticket in the Build Stage of this Spec. Once #${blocker} is done, the Ticket loop builds this one.`;
  }
  return "It waits for a blocker that is still open.";
}

/**
 * Pushes the Spec's integration branch, and only it, and opens one pull request
 * against the base branch with the host's Preview URL. A rerun pushes again and
 * finds the open pull request instead of opening a second one; if the push moved the
 * branch, as after a change the Builder asked for, the Preview is made anew, since
 * that is what the Builder reads. Either way the Spec now waits in the Approve Stage.
 */
async function openSpecPullRequest(options: LoopOptions): Promise<SpecPullRequest | undefined> {
  const { siteDir, spec, config, tracker, host, log } = options;
  const integration = integrationBranch(spec);
  if (!(await branchExists(siteDir, integration))) return undefined;
  if (await gitSucceeds(siteDir, "merge-base", "--is-ancestor", integration, config.baseBranch)) {
    log(`Spec #${spec}: every Ticket is done, but ${integration} holds nothing that ${config.baseBranch} does not, so there is no pull request to open.`);
    return undefined;
  }
  if (!(await gitSucceeds(siteDir, "remote", "get-url", REMOTE))) {
    throw new LoopError(
      `Every Ticket of Spec #${spec} passed, but this Site repository has no remote called ${REMOTE}, so ${integration} cannot become a pull request. Connect the Site to GitHub, then run the Ticket loop again.`,
    );
  }
  const pushedBefore = (await git(siteDir, "ls-remote", "--heads", REMOTE, `refs/heads/${integration}`)).split(/\s/)[0];
  const tip = (await git(siteDir, "rev-parse", integration)).trim();
  // An explicit refspec, so the push can only ever move the integration branch on the remote.
  try {
    await git(siteDir, "push", "--quiet", REMOTE, `refs/heads/${integration}:refs/heads/${integration}`);
  } catch (error) {
    throw new LoopError(`Every Ticket of Spec #${spec} passed, but pushing ${integration} to ${REMOTE} failed: ${(error as Error).message.trim()}`);
  }

  const existing = await tracker.pullRequestFrom(integration);
  if (existing && pushedBefore === tip) {
    log(`Spec #${spec}: pushed ${integration}, which holds nothing new for its pull request #${existing.number}`);
    await tracker.moveToStage(spec, "approve");
    return { ...existing, opened: false };
  }
  const preview = await host.deployPreview({ siteDir, branch: integration });
  const body = await pullRequestBody(options, preview);
  if (existing) {
    await tracker.updatePullRequest(existing.number, { body });
    log(`Spec #${spec}: pushed ${integration}, which updates its pull request #${existing.number}, with the new Preview ${preview}`);
    await tracker.moveToStage(spec, "approve");
    return { ...existing, body, preview, opened: false };
  }
  const { title } = await tracker.getIssue(spec);
  const pullRequest = await tracker.openPullRequest({ head: integration, base: config.baseBranch, title, body });
  log(`Spec #${spec}: opened pull request #${pullRequest.number} with the Preview ${preview}`);
  await tracker.moveToStage(spec, "approve");
  return { ...pullRequest, preview, opened: true };
}

async function pullRequestBody({ spec, tracker }: LoopOptions, preview: string): Promise<string> {
  const tickets = (await tracker.ticketsOf(spec)).sort((a, b) => a.number - b.number);
  return [
    `Every Ticket of Spec #${spec} passed the Ticket loop, and this pull request holds them all.`,
    "",
    `Preview: ${preview}`,
    "",
    "Tickets:",
    ...tickets.map((ticket) => `- #${ticket.number} ${ticket.title}`),
    "",
    `Read the Preview. When the Site does what Spec #${spec} asks, merge this pull request to Approve it.`,
  ].join("\n");
}

/** The Preview's address, as the Ticket loop wrote it in the pull request. */
export function previewIn(body: string): string | undefined {
  return /^Preview: (\S+)$/m.exec(body)?.[1];
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
    log(`Ticket #${ticket.number}: parked, waiting for you. ${firstLine(parkedFor.reason)}`);
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
  let failingChecks: string[] | undefined;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const catchUp = await catchUpWith(worktree, integration);
    const base = await git(siteDir, "rev-parse", integration);
    log(
      attempt === 1
        ? `Ticket #${ticket.number}: building on ${branch} in ${relative(siteDir, worktree)}`
        : `Ticket #${ticket.number}: fix round ${attempt - 1}, back to Build with the failing reason`,
    );
    await record(options, ticket, { status: "building", attempts: attempt, reason: reason || undefined, failingChecks });

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
      // Hitting the plan's limit is not the Ticket's failure: wait it out and resume the same attempt.
      await waitOutRateLimit(ticket, options, attempt, session.until, failingChecks);
      attempt--;
      continue;
    }

    const gate =
      session.kind === "failed"
        ? { passed: false as const, reason: `The Build session failed: ${session.reason}` }
        : await runGate(worktree, base, branch, integration, config.testCommand);
    if (gate.passed) {
      await record(options, ticket, { status: "reviewing", attempts: attempt, reason: reason || undefined, failingChecks });
      const review = await reviewTicket(ticket, options, worktree, base, gate.head, attempt);
      if ("question" in review) {
        return park(ticket, options, attempt, `The code review needs a decision from you: ${review.question}`, [
          "The code review stopped because it needs a decision only you can make:",
          "",
          review.question,
          "",
          `Answer in a comment on this Ticket, then run the Ticket loop again. The work so far stays on \`${branch}\`.`,
        ]);
      }
      if (review.failed === undefined) {
        // Recorded before anything moves, so a run that dies before the Pass comment finishes it next time.
        await git(siteDir, "update-ref", passRef(ticket.number), gate.head);
        const refused = await finishPass(ticket, options, gate.head);
        if (refused === undefined) {
          await record(options, ticket, { status: "passed", attempts: attempt });
          return "passed";
        }
        reason = refused;
        failingChecks = undefined;
      } else {
        reason = review.failed;
        failingChecks = review.failingChecks;
      }
    } else {
      reason = gate.reason;
      failingChecks = undefined;
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
  ], failingChecks);
}

type ReviewOutcome = { failed?: string; failingChecks?: string[] } | { question: string };

/**
 * A Ticket's Review of the commit its gate tested: the Review checks on its served build,
 * then the code review. The code review only ever runs on green checks, so no verdict of
 * its own can stand in for them. Whatever Review leaves in the worktree goes again.
 */
async function reviewTicket(ticket: Issue, options: LoopOptions, worktree: string, base: string, head: string, attempt: number): Promise<ReviewOutcome> {
  try {
    const failed = await runReviewChecks(options, worktree);
    if (failed !== undefined) return failed;
    return await runCodeReview(ticket, options, worktree, base, head, attempt);
  } finally {
    await restoreWorktree(worktree, ticketBranch(ticket.number), head);
  }
}

/** Why the Ticket's served build failed its Review checks and which ones, or undefined when it passed them. */
async function runReviewChecks({ config, reviewSite }: LoopOptions, worktree: string): Promise<{ failed: string; failingChecks?: string[] } | undefined> {
  try {
    const report = await withServedBuild(worktree, config, (url) => reviewSite(url, worktree));
    if (report.passed) return undefined;
    const failing = report.areas.flatMap((area) => area.checks).filter((check) => !check.passed);
    return { failed: formatFailures(report), failingChecks: failing.map((check) => check.name) };
  } catch (error) {
    return { failed: error instanceof ServeError ? error.message : couldNotRun(error) };
  }
}

async function runCodeReview(ticket: Issue, options: LoopOptions, worktree: string, base: string, head: string, attempt: number): Promise<ReviewOutcome> {
  const { agentCli, config, tracker, log } = options;
  for (;;) {
    await clearCodeReview(worktree);
    log(`Ticket #${ticket.number}: Review checks passed, code review`);
    const session = await agentCli.runSession({
      cwd: worktree,
      prompt: codeReviewPrompt(ticket, base),
      sandbox: true,
      timeoutMs: config.sessionTimeoutMs,
      stage: "review",
    });
    if (session.kind === "decision") return { question: session.question };
    if (session.kind === "failed") return { failed: `The code review session failed: ${session.reason}` };
    if (session.kind === "rate-limited") {
      await waitOutRateLimit(ticket, options, attempt, session.until);
      continue;
    }
    const review = await takeCodeReview(worktree);
    if (!review) return { failed: "The code review session left no report the Ticket loop could read, so nothing approved this Ticket." };
    if (review.points.length > 0) await tracker.comment(ticket.number, codeReviewComment(head, review));
    return review.verdict === "approve" ? {} : { failed: `The code review sent this Ticket back:\n\n${numberedPoints(review.points)}` };
  }
}

/**
 * Puts the Ticket's branch and worktree back on the commit the gate tested, which left the
 * tree clean: anything else there came from Review (build output, a session's edits).
 */
async function restoreWorktree(worktree: string, branch: string, head: string): Promise<void> {
  await git(worktree, "checkout", "--quiet", "--force", "-B", branch, head);
  await git(worktree, "clean", "--quiet", "--force", "-d");
}

/** Sleeps until the Agent CLI's rate limit lifts, showing the Ticket as waiting on the board meanwhile. */
async function waitOutRateLimit(ticket: Issue, options: LoopOptions, attempt: number, until: Date, failingChecks?: string[]): Promise<void> {
  const { clock, log } = options;
  const ms = Math.max(until.getTime() - clock.now().getTime(), MIN_RATE_LIMIT_WAIT_MS);
  const resume = new Date(clock.now().getTime() + ms);
  const reason = `The Agent CLI hit its plan's rate limit, so the Ticket loop waits until ${resume.toISOString()} and then resumes this Ticket.`;
  log(`Ticket #${ticket.number}: ${reason}`);
  await record(options, ticket, { status: "waiting", attempts: attempt, reason, resumeAt: resume.toISOString(), failingChecks });
  await clock.sleep(ms);
  log(`Ticket #${ticket.number}: the rate limit has lifted, resuming`);
}

/** Leaves the Ticket open in its Stage, says why on it, and marks it parked for the board. */
async function park(ticket: Issue, options: LoopOptions, attempts: number, reason: string, comment: string[], failingChecks?: string[]): Promise<Outcome> {
  options.log(`Ticket #${ticket.number}: parked. ${firstLine(reason)}`);
  await options.tracker.comment(ticket.number, `${PARKED} ${comment.join("\n")}\n\n<!-- factory attempts: ${attempts} -->`);
  await record(options, ticket, { status: "parked", attempts, reason, failingChecks });
  return "parked";
}

async function record(options: LoopOptions, ticket: Issue, state: TicketState): Promise<void> {
  await recordTicketState(join(options.siteDir, LOCAL_DIR), options.spec, ticket.number, state);
}

const PARKED = "Parked.";

/** The attempt count at the end of a park comment, hidden from the page so another machine's board can read it. */
const PARK_ATTEMPTS = /\s*<!-- factory attempts: (\d+) -->\s*$/;

/**
 * The park comment, when it is the last thing that happened on the Ticket. `attempts` is
 * missing when the comment carries no count, as one written by hand does.
 */
export function stillParked(history: IssueEvent[]): { reason: string; attempts?: number } | undefined {
  const last = history.at(-1);
  return last?.kind === "comment" && last.body.startsWith(PARKED) ? readPark(last.body) : undefined;
}

function readPark(comment: string): { reason: string; attempts?: number } {
  const body = comment.slice(PARKED.length);
  const count = PARK_ATTEMPTS.exec(body)?.[1];
  return { reason: body.replace(PARK_ATTEMPTS, "").trim(), ...(count === undefined ? {} : { attempts: Number(count) }) };
}

/**
 * The last park on the Ticket, also when something happened after it: `since` is what did,
 * without the loop's own code review comments, which answer nothing. A Pass since the park
 * settled it, so there is none then. The board reads this; `stillParked` is the loop's gate.
 */
export function lastPark(history: IssueEvent[]): { comment: string; reason: string; attempts?: number; since: IssueEvent[] } | undefined {
  const at = history.findLastIndex((event) => event.kind === "comment" && event.body.startsWith(PARKED));
  if (at === -1) return undefined;
  const since = history.slice(at + 1).filter((event) => event.kind !== "comment" || !isCodeReviewComment(event.body));
  if (since.some((event) => event.kind === "comment" && PASS_COMMENT.test(event.body))) return undefined;
  const comment = (history[at] as { body: string }).body;
  return { comment, ...readPark(comment), since };
}

/** What the session needs to know when the Builder answered a park: the park comment and everything said since. */
function answeredPark(history: IssueEvent[]): string | undefined {
  const park = lastPark(history);
  const said = park?.since.flatMap((event) => (event.kind === "comment" ? [event.body] : [])) ?? [];
  if (!park || said.length === 0) return undefined;
  return [
    "This Ticket was parked last time, with this on the Ticket:",
    "",
    park.comment,
    "",
    "The Builder answered since. Build exactly what the answer says:",
    "",
    ...said,
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

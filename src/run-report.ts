import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TicketState } from "./loop-state.ts";
import type { Issue } from "./tracker.ts";

/** Raised when a stored Run report's shape changes, so Measure can tell the old ones apart. */
const RUN_REPORT_VERSION = 1;

/** A reason in a Run report's words stays this short; the whole reason stays on the Ticket and in the stored report. */
const BRIEF_REASON_CHARS = 300;

/** An attempt that did not Pass, which sent the Ticket back to Build or parked it. */
export interface FailedAttempt {
  attempt: number;
  reason: string;
  /** The names of the Review checks that failed; empty when the attempt failed elsewhere, such as at the gate. */
  failingChecks: string[];
}

/** `unfinished`: the run stopped while this Ticket was being built. */
export type TicketOutcome = "passed" | "parked" | "not-passed" | "blocked" | "unfinished";

/** How one Ticket went in one run. */
export interface TicketRun {
  ticket: number;
  title: string;
  outcome: TicketOutcome;
  /** Build sessions in this run; 0 when it only finished an earlier Pass, or a blocker or an unanswered park kept the Ticket waiting. */
  attempts: number;
  fixRounds: number;
  failedAttempts: FailedAttempt[];
  /** Why a Ticket is parked or was not started. */
  reason?: string;
  /** What each red run said whose rerun was green. */
  flaky: string[];
  rateLimitWaitMs: number;
}

/** A run as it ends, before it is stored and gets its number. */
export type FinishedRun = Omit<RunReport, "run">;

/** One run of the Ticket loop, as Measure reads it across runs. */
export interface RunReport {
  version: number;
  spec: number;
  /** The run's number within its Spec, from 1. */
  run: number;
  startedAt: string;
  finishedAt: string;
  rateLimitWaitMs: number;
  tickets: TicketRun[];
  pullRequest?: { number: number; url: string; preview?: string };
  /** Why the run stopped before it was through, in plain words. */
  stopped?: string;
}

const OUTCOMES: Record<TicketState["status"], TicketOutcome> = {
  building: "unfinished",
  reviewing: "unfinished",
  waiting: "unfinished",
  passed: "passed",
  parked: "parked",
  "not-passed": "not-passed",
  blocked: "blocked",
};

/** Collects what happens in one run of the Ticket loop. */
export class RunRecorder {
  readonly #spec: number;
  readonly #startedAt: Date;
  readonly #tickets = new Map<number, TicketRun>();
  #stopped: string | undefined;

  constructor(spec: number, startedAt: Date) {
    this.#spec = spec;
    this.#startedAt = startedAt;
  }

  #entry({ number, title }: Issue): TicketRun {
    let entry = this.#tickets.get(number);
    if (!entry) {
      entry = { ticket: number, title, outcome: "unfinished", attempts: 0, fixRounds: 0, failedAttempts: [], flaky: [], rateLimitWaitMs: 0 };
      this.#tickets.set(number, entry);
    }
    return entry;
  }

  /** The Ticket's latest state; the last one of the run is its outcome. */
  ticketState(ticket: Issue, { status, attempts, reason }: Pick<TicketState, "status" | "attempts" | "reason">): void {
    const entry = this.#entry(ticket);
    entry.outcome = OUTCOMES[status];
    entry.attempts = attempts;
    entry.fixRounds = Math.max(attempts - 1, 0);
    if (status === "parked" || status === "blocked") entry.reason = reason;
  }

  failedAttempt(ticket: Issue, attempt: number, reason: string, failingChecks: string[] = []): void {
    this.#entry(ticket).failedAttempts.push({ attempt, reason, failingChecks });
  }

  flaky(ticket: Issue, redRun: string): void {
    this.#entry(ticket).flaky.push(redRun);
  }

  waited(ticket: Issue, ms: number): void {
    this.#entry(ticket).rateLimitWaitMs += ms;
  }

  stoppedBecause(reason: string): void {
    this.#stopped = reason;
  }

  finish(finishedAt: Date, pullRequest?: RunReport["pullRequest"]): FinishedRun {
    const tickets = [...this.#tickets.values()].sort((a, b) => a.ticket - b.ticket);
    return {
      version: RUN_REPORT_VERSION,
      spec: this.#spec,
      startedAt: this.#startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      rateLimitWaitMs: tickets.reduce((total, ticket) => total + ticket.rateLimitWaitMs, 0),
      tickets,
      ...(pullRequest ? { pullRequest } : {}),
      ...(this.#stopped === undefined ? {} : { stopped: this.#stopped }),
    };
  }
}

/** Every Run report stays in its own file here, for Measure: `.factory/run-reports/spec-<n>-run-<k>.json`. */
const reportsDir = (localDir: string): string => join(localDir, "run-reports");

const REPORT_FILE = /^spec-(\d+)-run-(\d+)\.json$/;

/** Stores the report as the next run of its Spec and returns it with that number. */
export async function saveRunReport(localDir: string, report: FinishedRun): Promise<RunReport> {
  const dir = reportsDir(localDir);
  await mkdir(dir, { recursive: true });
  const taken = (await readdir(dir)).flatMap((name) => {
    const match = REPORT_FILE.exec(name);
    return Number(match?.[1]) === report.spec ? [Number(match?.[2])] : [];
  });
  const saved: RunReport = { ...report, run: Math.max(0, ...taken) + 1 };
  const file = join(dir, `spec-${saved.spec}-run-${saved.run}.json`);
  // Moved into place whole, because the board may read this folder at any moment.
  await writeFile(`${file}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return saved;
}

/**
 * Every Run report of this Site, by Spec and then oldest first. What Measure reads. A file
 * that cannot be read as JSON is passed over, as the loop's state is.
 */
export async function readRunReports(localDir: string): Promise<RunReport[]> {
  const dir = reportsDir(localDir);
  const names = existsSync(dir) ? await readdir(dir) : [];
  const reports: RunReport[] = [];
  for (const name of names) {
    if (!REPORT_FILE.test(name)) continue;
    try {
      reports.push(JSON.parse(await readFile(join(dir, name), "utf8")) as RunReport);
    } catch {
      continue;
    }
  }
  return reports.sort((a, b) => a.spec - b.spec || a.run - b.run);
}

/** The newest Run report of each Spec, the highest Spec number first. */
export async function latestRunReports(localDir: string): Promise<RunReport[]> {
  const latest = new Map<number, RunReport>();
  for (const report of await readRunReports(localDir)) latest.set(report.spec, report);
  return [...latest.values()].reverse();
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A wait in hours and minutes; a part of a minute counts as a whole one. */
export function duration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const parts = [...(hours > 0 ? [count(hours, "hour")] : []), ...(minutes % 60 > 0 ? [count(minutes % 60, "minute")] : [])];
  return parts.join(" ") || "no time";
}

/** A reason's first line, joined to the next for as long as a line only introduces the next, as a park comment does a code review's list. */
function brief(reason: string): string {
  const lines = reason.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("```"));
  const ending = lines.findIndex((line) => !line.endsWith(":"));
  const text = lines.slice(0, ending === -1 ? lines.length : ending + 1).join(" ");
  return text.length > BRIEF_REASON_CHARS ? `${text.slice(0, BRIEF_REASON_CHARS - 3)}...` : text;
}

const isStraightThrough = (ticket: TicketRun) => ticket.outcome === "passed" && ticket.failedAttempts.length === 0;
const label = ({ ticket, title }: TicketRun) => `#${ticket} ${title}`;

/** The run in one line, the way the board lists it. */
export function runSummary(report: FinishedRun): string {
  const { tickets } = report;
  // A run with no Ticket either found none left, as the run that repairs the pull request does, or stopped first.
  if (tickets.length === 0) return report.stopped === undefined ? "No Ticket left to build." : "The run stopped before it built any Ticket.";
  const of = (outcome: TicketOutcome) => tickets.filter((ticket) => ticket.outcome === outcome).length;
  const straight = tickets.filter(isStraightThrough).length;
  const parts = [
    ...(straight > 0 ? [`${straight} straight through`] : []),
    ...(of("passed") - straight > 0 ? [`${of("passed") - straight} passed after fix rounds`] : []),
    ...(of("parked") > 0 ? [`${of("parked")} parked`] : []),
    ...(of("not-passed") > 0 ? [`${of("not-passed")} not passed`] : []),
    ...(of("blocked") > 0 ? [`${of("blocked")} not started`] : []),
    ...(of("unfinished") > 0 ? [`${of("unfinished")} unfinished`] : []),
    ...(report.rateLimitWaitMs > 0 ? [`waited ${duration(report.rateLimitWaitMs)} on rate limits`] : []),
  ];
  return `${count(tickets.length, "Ticket")}: ${parts.join(", ") || "nothing happened"}.`;
}

function straightThroughLine(ticket: TicketRun): string {
  return `- ${label(ticket)}${ticket.attempts === 0 ? ": an earlier run built it, and this run finished its Pass" : ""}`;
}

const FIX_ROUND_ENDINGS: Record<TicketOutcome, string> = {
  passed: "then it passed",
  parked: "it is parked",
  "not-passed": "it did not pass",
  blocked: "it is waiting",
  unfinished: "the run stopped",
};

function fixRoundLines(ticket: TicketRun): string[] {
  return [
    `- ${label(ticket)}: ${count(ticket.fixRounds, "fix round")}, ${FIX_ROUND_ENDINGS[ticket.outcome]}.`,
    ...ticket.failedAttempts.map(({ attempt, reason, failingChecks }) => {
      const checks = failingChecks.length > 0 ? ` (failing: ${failingChecks.join(", ")})` : "";
      return `  - Attempt ${attempt} did not pass${checks}: ${brief(reason)}`;
    }),
  ];
}

/** Each Review check that failed in the run, with the Tickets it failed on. */
function failedChecks(report: FinishedRun): string[] {
  const failedOn = new Map<string, Set<number>>();
  for (const { ticket, failedAttempts } of report.tickets) {
    for (const check of failedAttempts.flatMap((attempt) => attempt.failingChecks)) {
      failedOn.set(check, (failedOn.get(check) ?? new Set()).add(ticket));
    }
  }
  return [...failedOn].map(([check, tickets]) => `- ${check}: ${[...tickets].map((ticket) => `#${ticket}`).join(", ")}`);
}

/** The whole run in plain words, one block per thing that happened, without the ones that did not. */
export function runDetails(report: FinishedRun): string {
  const { tickets } = report;
  const section = (heading: string, lines: string[]) => (lines.length > 0 ? [[heading, ...lines].join("\n")] : []);
  const waits = tickets.filter((ticket) => ticket.rateLimitWaitMs > 0);
  const flaky = tickets.filter((ticket) => ticket.flaky.length > 0);
  const previewed = report.pullRequest?.preview ? ` Its Preview: ${report.pullRequest.preview}` : "";
  return [
    ...(report.stopped === undefined ? [] : [`The run stopped before it was through: ${brief(report.stopped)}`]),
    ...section("Went straight through:", tickets.filter(isStraightThrough).map(straightThroughLine)),
    ...section("Needed fix rounds:", tickets.filter((ticket) => ticket.fixRounds > 0).flatMap(fixRoundLines)),
    ...section("Parked, waiting for you:", tickets.filter((ticket) => ticket.outcome === "parked").map((ticket) => `- ${label(ticket)}: ${brief(ticket.reason ?? "") || "its park comment gives no reason"}`)),
    ...section("Not started:", tickets.filter((ticket) => ticket.outcome === "blocked").map((ticket) => `- ${label(ticket)}: ${brief(ticket.reason ?? "")}`)),
    ...section("Still unfinished when the run stopped:", tickets.filter((ticket) => ticket.outcome === "unfinished").map((ticket) => `- ${label(ticket)}`)),
    ...section("Flaky tests:", flaky.map((ticket) => `- ${label(ticket)}: the tests were red, then green on the rerun, which does not count as a failure. The red run: ${brief(ticket.flaky[0]!)}`)),
    ...section(`Waited on rate limits for ${duration(report.rateLimitWaitMs)}:`, waits.map((ticket) => `- ${label(ticket)}: ${duration(ticket.rateLimitWaitMs)}`)),
    ...section("Review checks that failed:", failedChecks(report)),
    ...(report.pullRequest ? [`Every Ticket of this Spec is done, in pull request #${report.pullRequest.number}.${previewed}`] : []),
  ].join("\n\n");
}

/** The comment on the Spec. */
export function runReportComment(report: FinishedRun): string {
  return `Run report of the Ticket loop. ${runSummary(report)}\n\n${runDetails(report)}`.trimEnd();
}

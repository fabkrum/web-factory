import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_DIR } from "./loop-state.ts";
import { brief, readRunReports, type RunReport, type TicketRun } from "./run-report.ts";
import type { Tracker } from "./tracker.ts";

/**
 * Measure, for the Factory (ADR 0006): it reads the Ticket loop's Run reports and, when a
 * pattern shows, proposes a Request to change the Factory's setup in the Site, with the cases
 * as evidence. The Request is filed in the Site's own repository, in the Request Stage, where
 * the Builder decides on it like on any other; nothing leaves the Site.
 */

/** How many different Tickets make a pattern: one or two can be bad luck. */
export const PATTERN_TICKETS = 3;

/** One time the pattern showed, as the Run report recorded it. */
export interface Case {
  spec: number;
  run: number;
  ticket: number;
  title: string;
  /** The attempt it showed in; missing for a park. */
  attempt?: number;
  reason: string;
}

/** What a pattern is about, and the Request that would change the Factory's setup for it. */
export interface Pattern {
  /** Stays the same across runs, so one pattern is proposed once for the same cases. */
  key: string;
  title: string;
  /** What showed, in plain words. */
  finding: string;
  /** What to change in the Factory's setup in the Site. */
  change: string;
  cases: Case[];
}

/** Why a Ticket parked, in kinds that say nothing about the Site's code or content. */
export type ParkKind = "decision" | "review-checks" | "time-limit" | "code-review" | "session-failed" | "gate";

const TIME_LIMIT = /ran past its time limit/;
const DECISION = /needs a decision (from you|only you can make)/;

/** Why a parked Ticket parked, from its reason and its last failed attempt; undefined for one parked in an earlier run. */
export function parkKind(ticket: TicketRun): ParkKind | undefined {
  if (ticket.outcome !== "parked") return undefined;
  if (DECISION.test(ticket.reason ?? "")) return "decision";
  const last = ticket.failedAttempts.at(-1);
  if (!last) return undefined;
  if (last.failingChecks.length > 0) return "review-checks";
  if (TIME_LIMIT.test(last.reason)) return "time-limit";
  if (/code review sent this Ticket back/.test(last.reason)) return "code-review";
  if (/session failed/.test(last.reason)) return "session-failed";
  return "gate";
}

/** The park kinds a pattern of their own covers; a park on Review checks or on time shows in those patterns already. */
const PARK_PATTERNS: Partial<Record<ParkKind, { title: string; finding: string; change: string }>> = {
  decision: {
    title: "Build keeps stopping for a decision",
    finding: "Tickets parked because a session needed a decision from you.",
    change:
      "Write the decisions the sessions kept asking for into AGENTS.md, or record them as an Architecture decision, so the next sessions find the answer there instead of stopping. The questions are in the park comments on the Tickets below.",
  },
  "code-review": {
    title: "The code review keeps sending Tickets back",
    finding: "Tickets parked because the code review sent them back on every attempt.",
    change: "Add what the code review kept pointing out to AGENTS.md, so Build gets it right the first time. Its points are in the comments on the Tickets below.",
  },
  gate: {
    title: "Tickets keep failing before Review",
    finding: "Tickets parked because their attempts did not get past the gate: the Site's tests were red, or a session left no usable commit.",
    change:
      "Check that the test command in factory.json runs the Site's tests and passes on the base branch, and say in AGENTS.md how this Site's tests are run and kept green.",
  },
  "session-failed": {
    title: "Build sessions keep failing",
    finding: "Tickets parked because the Agent CLI's sessions failed.",
    change: "Check that the Agent CLI is installed and logged in, and that the instructions in AGENTS.md ask for nothing a session cannot do unattended.",
  },
};

/** Each Ticket's latest case, oldest first: a Ticket counts once, however often it showed the pattern. */
function perTicket(cases: Case[]): Case[] {
  const latest = new Map<number, Case>();
  for (const found of cases) {
    latest.delete(found.ticket);
    latest.set(found.ticket, found);
  }
  return [...latest.values()];
}

/** Every pattern the Run reports show across at least three Tickets. */
export function findPatterns(reports: RunReport[]): Pattern[] {
  const byCheck = new Map<string, Case[]>();
  const tooBig: Case[] = [];
  const parks = new Map<ParkKind, Case[]>();
  for (const { spec, run, tickets } of reports) {
    for (const ticket of tickets) {
      const at = { spec, run, ticket: ticket.ticket, title: ticket.title };
      for (const { attempt, reason, failingChecks } of ticket.failedAttempts) {
        for (const check of new Set(failingChecks)) byCheck.set(check, [...(byCheck.get(check) ?? []), { ...at, attempt, reason: brief(reason) }]);
        if (TIME_LIMIT.test(reason)) tooBig.push({ ...at, attempt, reason: brief(reason) });
      }
      const kind = parkKind(ticket);
      if (kind && PARK_PATTERNS[kind]) parks.set(kind, [...(parks.get(kind) ?? []), { ...at, reason: brief(ticket.reason ?? "") }]);
    }
  }
  const patterns: Pattern[] = [];
  for (const [check, cases] of byCheck) {
    patterns.push({
      key: `check:${check}`,
      title: `The Review check "${check}" keeps failing`,
      finding: `The Review check "${check}" failed on different Tickets.`,
      change: `Add guidance to AGENTS.md that tells Build what the "${check}" check asks for and how this Site's stack meets it, so a Ticket passes it the first time instead of in fix rounds.`,
      cases: perTicket(cases),
    });
  }
  patterns.push({
    key: "too-big",
    title: "Tickets are too big to finish in one session",
    finding: "Build sessions ran past their time limit and were stopped before the Ticket was done.",
    change:
      "Have the spec skill cut Tickets smaller: add to AGENTS.md how big a Ticket in this Site may be. If the Tickets are already small, give a session more time with sessionTimeoutMs in factory.json.",
    cases: perTicket(tooBig),
  });
  for (const [kind, cases] of parks) patterns.push({ key: `park:${kind}`, ...PARK_PATTERNS[kind]!, cases: perTicket(cases) });
  return patterns.filter((pattern) => pattern.cases.length >= PATTERN_TICKETS);
}

/** Which Tickets each proposed pattern already had, so the same cases are never proposed twice. */
type Proposed = Record<string, { request: number; tickets: number[] }>;

const proposedFile = (siteDir: string) => join(siteDir, LOCAL_DIR, "factory-requests.json");

async function readProposed(siteDir: string): Promise<Proposed> {
  try {
    const parsed: unknown = JSON.parse(await readFile(proposedFile(siteDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Proposed) : {};
  } catch {
    return {};
  }
}

async function saveProposed(siteDir: string, proposed: Proposed): Promise<void> {
  const file = proposedFile(siteDir);
  await mkdir(join(siteDir, LOCAL_DIR), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(proposed, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

function caseLine({ spec, run, ticket, title, attempt, reason }: Case): string {
  return `- Ticket #${ticket} ${title} (Spec #${spec}, run ${run}${attempt === undefined ? "" : `, attempt ${attempt}`}): ${reason || "no reason recorded"}`;
}

/** The Request for a pattern, with its cases as evidence. */
export function factoryRequest(pattern: Pattern): { title: string; body: string } {
  return {
    title: `Factory: ${pattern.title}`,
    body: `Measure read the Ticket loop's Run reports and found a pattern, so it proposes this Request. It is about your Factory, the setup that builds your Site (its instructions in AGENTS.md, its skills, factory.json), not about the Site itself.

It travels the Pipeline like any other Request: you decide on it here, then it goes through Spec, the Ticket loop, Review and Approve, so nothing about how your Site is built changes without you. If you do not want it, close it.

## What showed

${pattern.finding} It happened on ${pattern.cases.length} Tickets:

${pattern.cases.map(caseLine).join("\n")}

## What to change

${pattern.change}

<!-- factory-pattern: ${pattern.key} -->
`,
  };
}

/**
 * Reads every Run report and files one Factory Request per pattern with new cases: one that
 * was proposed before is proposed again only when at least three Tickets showed it since.
 * Returns the numbers of the Requests it filed.
 */
export async function measureFactory(options: { siteDir: string; tracker: Tracker; stdout: (text: string) => void }): Promise<number[]> {
  const { siteDir, tracker, stdout } = options;
  const patterns = findPatterns(await readRunReports(join(siteDir, LOCAL_DIR)));
  const proposed = await readProposed(siteDir);
  const filed: number[] = [];
  for (const pattern of patterns) {
    const known = new Set(proposed[pattern.key]?.tickets ?? []);
    const cases = pattern.cases.filter((found) => !known.has(found.ticket));
    if (cases.length < PATTERN_TICKETS) continue;
    if (filed.length === 0) await tracker.ensureStageLabels();
    const number = await tracker.createIssue({ ...factoryRequest({ ...pattern, cases }), stage: "request", about: "factory" });
    proposed[pattern.key] = { request: number, tickets: [...known, ...cases.map((found) => found.ticket)] };
    // Recorded right away, so a stop after this Request files no second one for the same cases.
    await saveProposed(siteDir, proposed);
    filed.push(number);
    stdout(`Measure found a pattern in the Run reports (${pattern.title.toLowerCase()}, on ${cases.length} Tickets) and proposes Factory Request #${number} to change your Factory's setup. You decide on it like on any other Request.\n`);
  }
  return filed;
}

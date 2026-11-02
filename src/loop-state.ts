import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Local, uncommitted Factory state in the Site repository: worktrees and the loop's state per Spec. */
export const LOCAL_DIR = ".factory";

/** Where a Ticket stands in the Ticket loop, as the board shows it. */
export interface TicketState {
  status: "building" | "reviewing" | "waiting" | "passed" | "parked" | "not-passed" | "blocked";
  /** Build sessions in the run that set this status; 0 for a Ticket its blockers kept unstarted. */
  attempts: number;
  /** Why the Ticket is stuck, in plain words. */
  reason?: string;
  /** The names of the Review checks that failed on the Ticket's last attempt. */
  failingChecks?: string[];
  /** While waiting on a rate limit: when the Ticket loop resumes, as an ISO time. */
  resumeAt?: string;
}

export interface LoopState {
  tickets: Record<string, TicketState>;
}

/**
 * The Ticket loop's local state for one Spec, in `.factory/spec-<n>.json`. The tracker
 * stays the source of truth for Stages and for whether a parked Ticket was answered;
 * this file is what the board reads for attempts and reasons.
 */
export function loopStateFile(localDir: string, spec: number): string {
  return join(localDir, `spec-${spec}.json`);
}

export async function readLoopState(localDir: string, spec: number): Promise<LoopState> {
  const file = loopStateFile(localDir, spec);
  if (!existsSync(file)) return { tickets: {} };
  return JSON.parse(await readFile(file, "utf8")) as LoopState;
}

export async function recordTicketState(localDir: string, spec: number, ticket: number, state: TicketState): Promise<void> {
  const current = await readLoopState(localDir, spec);
  current.tickets[String(ticket)] = state;
  await mkdir(localDir, { recursive: true });
  // Moved into place whole, because the board reads this file while the loop writes it.
  const file = loopStateFile(localDir, spec);
  await writeFile(`${file}.tmp`, `${JSON.stringify(current, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * Every Ticket the loop has state for, across all Specs. A file that cannot be read as
 * JSON is passed over: the board then shows those Tickets from the tracker alone.
 */
export async function readAllLoopStates(localDir: string): Promise<Map<number, { spec: number; state: TicketState }>> {
  const found = new Map<number, { spec: number; state: TicketState }>();
  const files = existsSync(localDir) ? await readdir(localDir) : [];
  for (const name of files) {
    const spec = /^spec-(\d+)\.json$/.exec(name)?.[1];
    if (spec === undefined) continue;
    let tickets: LoopState["tickets"];
    try {
      ({ tickets } = await readLoopState(localDir, Number(spec)));
    } catch {
      continue;
    }
    for (const [ticket, state] of Object.entries(tickets)) found.set(Number(ticket), { spec: Number(spec), state });
  }
  return found;
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where a Ticket stands in the Ticket loop, as the board shows it. */
export interface TicketState {
  status: "building" | "waiting" | "passed" | "parked" | "not-passed" | "blocked";
  /** Build sessions in the run that set this status; 0 for a Ticket its blockers kept unstarted. */
  attempts: number;
  /** Why the Ticket is stuck, in plain words. */
  reason?: string;
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
  await writeFile(loopStateFile(localDir, spec), `${JSON.stringify(current, null, 2)}\n`);
}

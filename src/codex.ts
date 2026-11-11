import { resolve } from "node:path";
import type { AgentCli, Session, SessionResult } from "./agent-cli.ts";
import { DECISION_RULES, takeDecisionRequest } from "./decision-request.ts";
import { git } from "./git.ts";
import { firstLines, runSessionProcess } from "./session-process.ts";

/** How long to wait when Codex says its limit is reached without saying until when. */
const UNNAMED_RESET_WAIT_MS = 15 * 60 * 1000;

const LIMIT = /usage limit|rate.?limit|\b429\b|too many requests/i;

export interface CodexOptions {
  /** The command and its leading arguments; `["codex"]` unless a test runs a fake. */
  command?: string[];
  /** Added to the environment the session inherits. */
  env?: Record<string, string>;
  /**
   * Whether a sandboxed session may reach the network. Codex's sandbox knows only all or
   * nothing, so it is off unless the Site needs it: with it on, a session could reach any
   * remote, the Builder's GitHub included.
   */
  network?: boolean;
  now?: () => Date;
}

/**
 * Codex in its unattended mode (`codex exec --json`) as an Agent CLI. It reads the Site's
 * AGENTS.md and `.agents/skills` from the session's directory by itself; the rules for
 * asking the Builder a decision travel at the head of the prompt.
 */
export class Codex implements AgentCli {
  readonly #command: string[];
  readonly #env: Record<string, string>;
  readonly #network: boolean;
  readonly #now: () => Date;

  constructor(options: CodexOptions = {}) {
    this.#command = options.command ?? ["codex"];
    this.#env = options.env ?? {};
    this.#network = options.network ?? false;
    this.#now = options.now ?? (() => new Date());
  }

  async runSession(session: Session): Promise<SessionResult> {
    const cwd = resolve(session.cwd);
    // A worktree commits into its repository's own .git, which lies outside the worktree.
    const gitDir = resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir"));
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      session.sandbox ? "workspace-write" : "danger-full-access",
      "--add-dir",
      gitDir,
      // Nobody is there to approve a command: whatever the sandbox refuses stays refused.
      "-c",
      'approval_policy="never"',
      // Set here so the Builder's own config.toml cannot widen a session.
      "-c",
      `sandbox_workspace_write.network_access=${this.#network}`,
      // The prompt comes on stdin.
      "-",
    ];

    const run = await runSessionProcess({
      command: [...this.#command, ...args],
      cwd,
      env: this.#env,
      input: `${DECISION_RULES}\n\n${session.prompt}`,
      timeoutMs: session.timeoutMs,
      cli: "Codex",
      commandName: "codex",
    });
    // A question the session left wins over however it ended: it stopped to ask.
    const question = await takeDecisionRequest(cwd);
    if (question !== undefined) return { kind: "decision", question };
    if ("failure" in run) return { kind: "failed", reason: run.failure };

    const events = jsonLines(run.stdout);
    const completed = events.some((event) => event.type === "turn.completed");
    if (run.code === 0 && completed) return { kind: "done" };

    const error = errorOf(events) || run.stderr.trim() || `codex exited with code ${run.code} and printed nothing`;
    if (LIMIT.test(error)) {
      const now = this.#now();
      return { kind: "rate-limited", until: codexResetTime(error, now) ?? new Date(now.getTime() + UNNAMED_RESET_WAIT_MS) };
    }
    if (events.length === 0 && run.code === 0) return { kind: "failed", reason: "Codex's output was not the JSON Lines it promises." };
    return { kind: "failed", reason: `Codex stopped with an error: ${firstLines(error)}` };
  }
}

interface CodexEvent {
  type?: unknown;
  message?: unknown;
  error?: { message?: unknown };
}

/** `codex exec --json` prints one JSON event per line; anything else on stdout is skipped. */
function jsonLines(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) events.push(parsed as CodexEvent);
    } catch {
      // Not an event.
    }
  }
  return events;
}

/** Why the turn failed: its `turn.failed` error, else the last `error` event. */
function errorOf(events: CodexEvent[]): string {
  const failed = events.findLast((event) => event.type === "turn.failed")?.error?.message;
  if (typeof failed === "string" && failed.trim()) return failed.trim();
  const error = events.findLast((event) => event.type === "error")?.message;
  return typeof error === "string" ? error.trim() : "";
}

const AGAIN_AT =
  /try again at\s+(?:(?<mon>[A-Z][a-z]{2})[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(?<year>\d{4}),?\s+)?)?(?<h>\d{1,2}):(?<m>\d{2})\s*(?<ap>am|pm)\b/i;
const AGAIN_IN = /try again in\s+([^.]*(?:\.\d+[^.]*)?)/i;
const DURATION = /(\d+(?:\.\d+)?)\s*(ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
const UNIT_MS: Record<string, number> = { ms: 1, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When Codex's limit lifts, read from its error text: `try again at 3:45 PM`,
 * `try again at Oct 27th, 2026 4:30 PM` (both in the machine's own time zone, as Codex
 * prints them), or `try again in 2 days 3 hours 5 minutes` / `in 1.5s`.
 */
export function codexResetTime(error: string, now: Date): Date | undefined {
  const at = AGAIN_AT.exec(error)?.groups;
  if (at) {
    const hour = (Number(at.h) % 12) + (at.ap!.toLowerCase() === "pm" ? 12 : 0);
    const minute = Number(at.m);
    const month = at.mon ? MONTHS.indexOf(at.mon.toLowerCase().slice(0, 3)) : -1;
    if (month >= 0) {
      const year = at.year ? Number(at.year) : now.getFullYear();
      let when = new Date(year, month, Number(at.day), hour, minute);
      if (!at.year && when.getTime() < now.getTime() - 24 * 3600 * 1000) when = new Date(year + 1, month, Number(at.day), hour, minute);
      return when;
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    return today.getTime() > now.getTime() ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute);
  }

  const span = AGAIN_IN.exec(error)?.[1];
  if (span === undefined) return undefined;
  if (/less than a minute/i.test(span)) return new Date(now.getTime() + 60_000);
  let ms = 0;
  for (const [, amount, unit] of span.matchAll(DURATION)) {
    const key = unit!.toLowerCase();
    ms += Number(amount) * UNIT_MS[key === "ms" ? "ms" : key[0]!]!;
  }
  return ms > 0 ? new Date(now.getTime() + Math.ceil(ms)) : undefined;
}

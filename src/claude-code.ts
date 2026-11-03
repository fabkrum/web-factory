import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentCli, Session, SessionResult } from "./agent-cli.ts";
import { DECISION_RULES, takeDecisionRequest } from "./decision-request.ts";
import { git } from "./git.ts";
import { firstLines, runSessionProcess } from "./session-process.ts";

/**
 * Commands a session may never run, sandbox or not: pushing is the Ticket loop's job,
 * and the loop only ever pushes the integration branch, never the Builder's main.
 */
const DENIED = ["Bash(git push:*)", "Bash(gh pr:*)", "Bash(gh repo:*)", "Bash(gh api:*)", "Bash(git worktree:*)"];

/** The hosts a sandboxed session may reach: the package registry, so it can install dependencies. */
const ALLOWED_DOMAINS = ["registry.npmjs.org"];

/** How long to wait when Claude Code says its limit is reached without saying until when. */
const UNNAMED_RESET_WAIT_MS = 15 * 60 * 1000;

const LIMIT = /usage limit|hit your limit|limit reached|rate.?limit|\b429\b|overloaded|\b529\b/i;

export interface ClaudeCodeOptions {
  /** The command and its leading arguments; `["claude"]` unless a test runs a fake. */
  command?: string[];
  /** Added to the environment the session inherits. */
  env?: Record<string, string>;
  /** Hosts a sandboxed session may reach; the npm registry unless the Site needs others. */
  allowedDomains?: string[];
  now?: () => Date;
}

/**
 * Claude Code in print mode (`claude -p`) as an Agent CLI. It reads the Site's CLAUDE.md
 * and `.claude/skills` from the session's directory by itself; a Site that keeps its
 * instructions in AGENTS.md only gets them appended to the system prompt.
 */
export class ClaudeCode implements AgentCli {
  readonly #command: string[];
  readonly #env: Record<string, string>;
  readonly #allowedDomains: string[];
  readonly #now: () => Date;

  constructor(options: ClaudeCodeOptions = {}) {
    this.#command = options.command ?? ["claude"];
    this.#env = options.env ?? {};
    this.#allowedDomains = options.allowedDomains ?? ALLOWED_DOMAINS;
    this.#now = options.now ?? (() => new Date());
  }

  async runSession(session: Session): Promise<SessionResult> {
    const cwd = resolve(session.cwd);
    const args = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      // Only the Site's own settings: the Builder's personal ones must not widen what a session may do.
      "--setting-sources",
      "project",
      "--settings",
      JSON.stringify(await this.#settings(cwd, session.sandbox)),
      // Nobody is there to answer a permission prompt: whatever would ask is refused.
      "--permission-prompts",
      "none",
      "--permission-mode",
      session.sandbox ? "acceptEdits" : "bypassPermissions",
      "--disallowedTools",
      ...DENIED,
      "--append-system-prompt",
      await systemPrompt(cwd),
    ];

    const run = await runSessionProcess({
      command: [...this.#command, ...args],
      cwd,
      env: this.#env,
      input: session.prompt,
      timeoutMs: session.timeoutMs,
      cli: "Claude Code",
      commandName: "claude",
    });
    // A question the session left wins over however it ended: it stopped to ask.
    const question = await takeDecisionRequest(cwd);
    if (question !== undefined) return { kind: "decision", question };
    if ("failure" in run) return { kind: "failed", reason: run.failure };

    const result = lastJson(run.stdout);
    const said = typeof result?.result === "string" ? result.result.trim() : "";
    const failed = run.code !== 0 || result === undefined || result.is_error === true;
    if (!failed) return { kind: "done" };

    const error = said || run.stderr.trim() || `claude exited with code ${run.code} and printed nothing`;
    if (LIMIT.test(error)) {
      const now = this.#now();
      return { kind: "rate-limited", until: resetTime(error, now) ?? new Date(now.getTime() + UNNAMED_RESET_WAIT_MS) };
    }
    if (result === undefined && run.code === 0) return { kind: "failed", reason: "Claude Code's output was not the JSON it promises." };
    return { kind: "failed", reason: `Claude Code stopped with an error: ${firstLines(error)}` };
  }

  async #settings(cwd: string, sandbox: boolean): Promise<unknown> {
    // A worktree commits into its repository's own .git, which lies outside the worktree.
    const gitDir = resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir"));
    return {
      sandbox: {
        enabled: sandbox,
        // Without this, a machine with no sandbox backend runs the session's shell unconfined.
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: this.#allowedDomains },
        filesystem: { allowWrite: [gitDir] },
      },
      permissions: { deny: DENIED },
    };
  }
}

async function systemPrompt(cwd: string): Promise<string> {
  const parts = [DECISION_RULES];
  if (!existsSync(join(cwd, "CLAUDE.md")) && existsSync(join(cwd, "AGENTS.md"))) {
    parts.push(`The Site's instructions, from AGENTS.md; follow them:\n\n${await readFile(join(cwd, "AGENTS.md"), "utf8")}`);
  }
  return parts.join("\n\n");
}

interface ClaudeResult {
  is_error?: boolean;
  result?: unknown;
}

/** Claude Code prints its result as one JSON object, the last line of its output. */
function lastJson(stdout: string): ClaudeResult | undefined {
  const last = stdout.trim().split("\n").at(-1);
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeResult) : undefined;
  } catch {
    return undefined;
  }
}

const RESET_EPOCH = /\|(\d{10})\b|resets?(?:At)?\D{0,12}?(\d{10})\b/;
const RESET_CLOCK =
  /resets?\s+(?:at\s+)?(?:(?<mon>[A-Z][a-z]{2})[a-z]*\.?\s+(?<day>\d{1,2}),?\s+(?:at\s+)?)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)\b(?:\s*\((?<tz>[A-Za-z_]+\/[A-Za-z_/]+)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When Claude Code's limit lifts, read from its error text: `…|1760000000`, `resets 3pm`,
 * `resets Oct 20, 4pm (Europe/Berlin)`. A clock time without a date is the next time it
 * comes round; without a time zone it is the machine's own.
 */
export function resetTime(error: string, now: Date): Date | undefined {
  const epoch = RESET_EPOCH.exec(error);
  if (epoch) return new Date(Number(epoch[1] ?? epoch[2]) * 1000);
  const clock = RESET_CLOCK.exec(error)?.groups;
  if (!clock) return undefined;

  const hour = (Number(clock.h) % 12) + (clock.ap!.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(clock.m ?? 0);
  const zone = clock.tz && isTimeZone(clock.tz) ? clock.tz : undefined;
  const today = wallDate(now, zone);
  const month = clock.mon ? MONTHS.indexOf(clock.mon.toLowerCase().slice(0, 3)) : -1;
  if (month >= 0) {
    let at = zonedTime(today.year, month, Number(clock.day), hour, minute, zone);
    if (at.getTime() < now.getTime() - 24 * 3600 * 1000) at = zonedTime(today.year + 1, month, Number(clock.day), hour, minute, zone);
    return at;
  }
  const at = zonedTime(today.year, today.month, today.day, hour, minute, zone);
  return at.getTime() > now.getTime() ? at : zonedTime(today.year, today.month, today.day + 1, hour, minute, zone);
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date `at` falls on in `zone` (the machine's own without one); month counts from 0. */
function wallDate(at: Date, zone: string | undefined): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year!, month: parts.month! - 1, day: parts.day! };
}

/** The instant a wall-clock time in `zone` names (the machine's own zone without one). */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): Date {
  if (!zone) return new Date(year, month, day, hour, minute);
  const asUtc = Date.UTC(year, month, day, hour, minute);
  // Shift by the zone's offset at that moment; a second pass settles a daylight-saving change.
  let at = asUtc;
  for (let pass = 0; pass < 2; pass++) at = asUtc - offsetOf(new Date(at), zone);
  return new Date(at);
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in milliseconds. */
function offsetOf(at: Date, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

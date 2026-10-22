import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentCli, Session, SessionResult } from "./agent-cli.ts";
import { DECISION_RULES, takeDecisionRequest } from "./decision-request.ts";
import { git } from "./git.ts";
import { firstLines, runSessionProcess } from "./session-process.ts";

/** How long to wait when the CLI says its limit is reached without saying until when. */
const UNNAMED_RESET_WAIT_MS = 15 * 60 * 1000;

/**
 * How much longer than the session's own time limit Antigravity CLI is told to wait. The
 * Ticket loop's limit stops the session; Antigravity's own would end it early and, past its
 * deadline, report the partial work as a success.
 */
const PRINT_TIMEOUT_MARGIN_S = 60;

const LIMIT = /rate.?limit|\b429\b|too many requests|resource.?exhausted|quota|exhausted your capacity|usage limit/i;
/** Limits that waiting does not lift: money has to be added first. */
const NOT_WAITABLE = /credits? balance is too low|spend(?:ing)? cap/i;

/** Commands a Gemini CLI session may never run, sandbox or not: pushing is the Ticket loop's job. */
const DENIED = ["git push", "gh pr", "gh repo", "gh api", "git worktree"].map((command) => `run_shell_command(${command})`);

/**
 * The two Google Agent CLIs. Antigravity CLI (`agy`) serves free Google accounts; Gemini CLI
 * (`gemini`) serves a paid Gemini API key. Both take the prompt with `-p`, print one JSON
 * result with `--output-format json`, read AGENTS.md and `.agents/skills`, and run commands
 * in a sandbox with `--sandbox`; they differ in a few flags.
 */
export type GoogleCliName = "antigravity" | "gemini";

const CLIS: Record<GoogleCliName, { name: string; command: string }> = {
  antigravity: { name: "Antigravity CLI", command: "agy" },
  gemini: { name: "Gemini CLI", command: "gemini" },
};

export interface GoogleCliOptions {
  cli: GoogleCliName;
  /** The command and its leading arguments; `["agy"]` or `["gemini"]` unless a test runs a fake. */
  command?: string[];
  /** Added to the environment the session inherits. */
  env?: Record<string, string>;
  now?: () => Date;
}

/**
 * Antigravity CLI or Gemini CLI in headless mode (`-p`) as an Agent CLI, one adapter for
 * both. The rules for asking the Builder a decision travel at the head of the prompt, as
 * neither has a system-prompt flag.
 */
export class GoogleCli implements AgentCli {
  readonly #cli: GoogleCliName;
  readonly #command: string[];
  readonly #env: Record<string, string>;
  readonly #now: () => Date;

  constructor(options: GoogleCliOptions) {
    this.#cli = options.cli;
    this.#command = options.command ?? [CLIS[options.cli].command];
    this.#env = options.env ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async runSession(session: Session): Promise<SessionResult> {
    const { name, command } = CLIS[this.#cli];
    const cwd = resolve(session.cwd);
    // A worktree commits into its repository's own .git, which lies outside the worktree.
    const gitDir = resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir"));
    // Named in the prompt too: Antigravity CLI has been seen working elsewhere in print mode unless told where.
    const prompt = `${DECISION_RULES}\n\nYour working directory is ${cwd}.\n\n${session.prompt}`;
    const args = ["-p", prompt, "--output-format", "json"];
    const env = { ...this.#env };
    let settingsDir: string | undefined;

    if (this.#cli === "antigravity") {
      args.push(
        "--print-timeout",
        `${Math.ceil(session.timeoutMs / 1000) + PRINT_TIMEOUT_MARGIN_S}s`,
        // Nobody is there to approve a tool: the terminal sandbox is what bounds a session.
        "--dangerously-skip-permissions",
        "--add-dir",
        gitDir,
      );
      if (session.sandbox) args.push("--sandbox");
    } else {
      // Nobody is there to approve a tool: the sandbox and the denied commands bound a session.
      args.push("--approval-mode", "yolo", "--include-directories", gitDir);
      if (session.sandbox) args.push("--sandbox");
      else env.GEMINI_SANDBOX = "false";
      // Gemini CLI reads GEMINI.md unless told otherwise. Its system settings outrank the
      // Builder's and the Site's own, so a session always reads AGENTS.md and never pushes.
      settingsDir = await mkdtemp(join(tmpdir(), "web-factory-gemini-"));
      const settings = join(settingsDir, "settings.json");
      await writeFile(settings, JSON.stringify({ context: { fileName: ["AGENTS.md", "GEMINI.md"] }, tools: { exclude: DENIED } }));
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settings;
    }

    const run = await runSessionProcess({
      command: [...this.#command, ...args],
      cwd,
      env,
      input: "",
      timeoutMs: session.timeoutMs,
      cli: name,
      commandName: command,
    }).finally(() => settingsDir && rm(settingsDir, { recursive: true, force: true }));
    // A question the session left wins over however it ended: it stopped to ask.
    const question = await takeDecisionRequest(cwd);
    if (question !== undefined) return { kind: "decision", question };
    if ("failure" in run) return { kind: "failed", reason: run.failure };

    const result = jsonResult(run.stdout);
    const failed = run.code !== 0 || result === undefined || result.error != null || (result.status !== undefined && result.status !== "SUCCESS");
    if (!failed) return { kind: "done" };

    const error =
      messageOf(result?.error) ||
      messageOf(jsonResult(run.stderr)?.error) ||
      agyError(run.stderr) ||
      run.stderr.trim() ||
      (typeof result?.status === "string" ? `the session ended ${result.status}` : "") ||
      `${command} exited with code ${run.code} and printed nothing`;
    if (LIMIT.test(error) && !NOT_WAITABLE.test(error)) {
      const now = this.#now();
      return { kind: "rate-limited", until: googleResetTime(error, now) ?? new Date(now.getTime() + UNNAMED_RESET_WAIT_MS) };
    }
    if (result === undefined && run.code === 0) return { kind: "failed", reason: `${name}'s output was not the JSON it promises.` };
    return { kind: "failed", reason: `${name} stopped with an error: ${firstLines(error)}` };
  }
}

interface GoogleResult {
  status?: unknown;
  response?: unknown;
  error?: unknown;
}

/** The one JSON object the CLI prints, pretty-printed or on one line, after anything else it printed. */
function jsonResult(output: string): GoogleResult | undefined {
  const text = output.trim();
  const starts = [0, ...[...text.matchAll(/\n\{/g)].map((match) => match.index + 1)].reverse();
  for (const start of starts) {
    try {
      const parsed = JSON.parse(text.slice(start)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as GoogleResult;
    } catch {
      // Not the result.
    }
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error.trim();
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message.trim() : "";
}

/** Antigravity CLI's structured error line on stderr: `AGY_ERROR: {...}`. */
function agyError(stderr: string): string {
  const line = /^AGY_ERROR:\s*(\{.*\})\s*$/m.exec(stderr)?.[1];
  if (!line) return "";
  try {
    const parsed = JSON.parse(line) as { message?: unknown; error?: unknown };
    return messageOf(parsed) || messageOf(parsed.error);
  } catch {
    return "";
  }
}

const AFTER = /(?:retry in|reset after|resets? in|try again in)\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i;
const DURATION = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
const UNIT_MS: Record<string, number> = { ms: 1, h: 3_600_000, m: 60_000, s: 1000 };

/**
 * When a Google CLI's limit lifts, read from its error text: `Please retry in 40.02s`,
 * `in 900.2ms`, or `Your quota will reset after 19h14m47s`.
 */
export function googleResetTime(error: string, now: Date): Date | undefined {
  const span = AFTER.exec(error)?.[1];
  if (span === undefined) return undefined;
  let ms = 0;
  for (const [, amount, unit] of span.matchAll(DURATION)) ms += Number(amount) * UNIT_MS[unit!.toLowerCase()]!;
  return ms > 0 ? new Date(now.getTime() + Math.ceil(ms)) : undefined;
}

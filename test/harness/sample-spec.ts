import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentCli } from "../../src/agent-cli.ts";
import { ClaudeCode } from "../../src/claude-code.ts";
import { factory } from "../../src/cli.ts";
import { systemClock, type Clock } from "../../src/clock.ts";
import { Codex } from "../../src/codex.ts";
import type { AgentCliName } from "../../src/config.ts";
import { GoogleCli } from "../../src/google-cli.ts";
import { lastPark, type ReviewSite } from "../../src/ticket-loop.ts";
import { FakeHost } from "./fake-host.ts";
import { FakeTracker } from "./fake-tracker.ts";
import { commitFile, git } from "./site-repo.ts";

const REPOSITORY = resolve(import.meta.dirname, "..", "..");
const SAMPLE = join(REPOSITORY, "test", "fixtures", "sample-spec");
const TEMPLATE = join(REPOSITORY, "packages", "create-web-factory", "template");

/**
 * All the waiting one nightly run does on rate limits, added up. A limit that keeps coming back
 * is retried without end, so past this total the run stops; otherwise the job's timeout of 120
 * minutes would cancel it without a report. The total leaves that timeout room for the sessions.
 */
const RATE_LIMIT_PATIENCE_MS = 30 * 60 * 1000;

interface SupportedCli {
  title: string;
  command: string;
  /** Any one of these is enough for the Agent CLI to log in. */
  keys: string[];
  /** The CI secret its key comes from. */
  secret: string;
  create: () => AgentCli;
}

export const SUPPORTED_CLIS: Record<AgentCliName, SupportedCli> = {
  "claude-code": { title: "Claude Code", command: "claude", keys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], secret: "CONTRACT_ANTHROPIC_API_KEY", create: () => new ClaudeCode() },
  codex: { title: "Codex", command: "codex", keys: ["CODEX_API_KEY"], secret: "CONTRACT_OPENAI_API_KEY", create: () => new Codex() },
  antigravity: { title: "Antigravity CLI", command: "agy", keys: ["GEMINI_API_KEY"], secret: "CONTRACT_GEMINI_API_KEY", create: () => new GoogleCli({ cli: "antigravity" }) },
  gemini: { title: "Gemini CLI", command: "gemini", keys: ["GEMINI_API_KEY"], secret: "CONTRACT_GEMINI_PAID_API_KEY", create: () => new GoogleCli({ cli: "gemini" }) },
};

export type SampleRun =
  | { outcome: "pass"; pullRequest: string; preview: string }
  /** The Ticket waits for a Builder, as it would on a Builder's Site. */
  | { outcome: "parked"; reason: string }
  /** The run ended without a Pass or a park, as when a rate limit lifts too late. */
  | { outcome: "stopped"; reason: string };

export type NightlyRun = SampleRun | { outcome: "skipped"; reason: string };

/** A throwaway Site repository made from the sample, with the instructions and skills every Site starts with, and a bare `origin`. */
export function createSampleSite(): string {
  const site = mkdtempSync(join(tmpdir(), "web-factory-sample-"));
  git(site, "init", "-q", "-b", "main");
  git(site, "config", "user.name", "Sample Builder");
  git(site, "config", "user.email", "builder@example.com");
  git(site, "config", "commit.gpgsign", "false");
  cpSync(TEMPLATE, site, { recursive: true, filter: (path) => !path.endsWith(".devcontainer") });
  cpSync(join(SAMPLE, "site"), site, { recursive: true });
  renameSync(join(site, "gitignore"), join(site, ".gitignore"));
  mkdirSync(join(site, ".claude"));
  symlinkSync(join("..", ".agents", "skills"), join(site, ".claude", "skills"));
  const instructions = readFileSync(join(site, "AGENTS.md"), "utf8");
  writeFileSync(join(site, "AGENTS.md"), instructions.slice(0, instructions.indexOf("## Stack")) + readFileSync(join(SAMPLE, "stack.md"), "utf8"));
  git(site, "add", "-A");
  git(site, "commit", "-q", "-m", "Start the sample Site");
  const origin = mkdtempSync(join(tmpdir(), "web-factory-sample-origin-"));
  git(origin, "init", "-q", "--bare");
  git(site, "remote", "add", "origin", origin);
  git(site, "push", "-q", "origin", "main");
  return site;
}

/** What the Ticket asks for, as a Build session would do it: the scripted Agent CLI's solution. */
export function buildSampleTicket(cwd: string): void {
  const home = readFileSync(join(cwd, "index.html"), "utf8");
  commitFile(
    cwd,
    "index.html",
    home.replace("    </main>", "      <h2>Opening hours</h2>\n      <p>Open Monday to Friday, 7:00 to 18:00.</p>\n    </main>"),
    "Show the opening hours",
  );
}

/** The real clock, except that a wait the nightly run cannot afford ends the run with the reason. One clock per run: it adds up the waits. */
export class PatientClock implements Clock {
  readonly #clock: Clock;
  #waitedMs = 0;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  now(): Date {
    return this.#clock.now();
  }

  async sleep(ms: number): Promise<void> {
    if (this.#waitedMs + ms > RATE_LIMIT_PATIENCE_MS) {
      throw new Error(
        `The Agent CLI's rate limit lifts in ${Math.ceil(ms / 60_000)} minutes. This run has already waited ${Math.ceil(this.#waitedMs / 60_000)} minutes, and a nightly run waits ${RATE_LIMIT_PATIENCE_MS / 60_000} minutes in total.`,
      );
    }
    this.#waitedMs += ms;
    await this.#clock.sleep(ms);
  }
}

/** Runs the sample Spec through the real `factory loop` with this Agent CLI; the tracker and the host are fakes. */
export async function runSampleSpec(options: { agentCli: AgentCli; reviewSite?: ReviewSite; clock?: Clock; log?: (text: string) => void }): Promise<SampleRun> {
  const { title, body, ticket: sample } = JSON.parse(readFileSync(join(SAMPLE, "spec.json"), "utf8")) as { title: string; body: string; ticket: { title: string; body: string } };
  const tracker = new FakeTracker();
  const spec = tracker.addSpec(title, body);
  const ticket = tracker.addTicket(spec, sample.title, sample.body);
  const host = new FakeHost();
  let printed = "";
  const print = (text: string) => {
    printed += text;
    options.log?.(text);
  };
  let exitCode: number;
  try {
    exitCode = await factory(["loop", String(spec)], {
      cwd: createSampleSite(),
      agentCli: options.agentCli,
      tracker,
      host,
      reviewSite: options.reviewSite,
      clock: options.clock ?? new PatientClock(),
      stdout: print,
      stderr: print,
    });
  } catch (error) {
    return { outcome: "stopped", reason: (error as Error).message };
  }
  const park = lastPark(await tracker.historyOf(ticket));
  if (park) return { outcome: "parked", reason: park.reason };
  const pullRequest = tracker.pullRequests.find((candidate) => candidate.state === "open");
  const preview = host.previews.at(-1)?.url;
  if (exitCode === 0 && tracker.issue(ticket).state === "closed" && pullRequest && preview) return { outcome: "pass", pullRequest: pullRequest.url, preview };
  return { outcome: "stopped", reason: printed.trim() || "The Ticket loop ended without a Pass and without saying why." };
}

/** Why this Agent CLI cannot run here, or undefined when it can. */
function whySkipped(cli: AgentCliName, env: NodeJS.ProcessEnv): string | undefined {
  const { title, command, keys, secret } = SUPPORTED_CLIS[cli];
  if (!keys.some((key) => env[key])) return `${keys.join(" or ")} is not set; in CI it comes from the ${secret} secret.`;
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", timeout: 30_000, env });
  } catch {
    return `${title} (${command}) is not installed.`;
  }
  return undefined;
}

/** One night's run on one Agent CLI: skipped with the reason when it cannot run, otherwise the sample Spec. */
export async function runNightly(cli: AgentCliName, env: NodeJS.ProcessEnv, log?: (text: string) => void): Promise<NightlyRun> {
  const reason = whySkipped(cli, env);
  if (reason) return { outcome: "skipped", reason };
  return runSampleSpec({ agentCli: SUPPORTED_CLIS[cli].create(), log });
}

const VERDICTS = { pass: "Pass", parked: "Parked", stopped: "Stopped", skipped: "Skipped" };

/** The run in plain words, the way the nightly report shows it. */
export function describeRun(cli: AgentCliName, run: NightlyRun): string {
  const detail = run.outcome === "pass" ? `Pull request ${run.pullRequest} with the Preview ${run.preview}.` : run.reason;
  return `${SUPPORTED_CLIS[cli].title}: ${VERDICTS[run.outcome]}. ${detail}\n`;
}

/** Adds the line to the GitHub job summary, when there is one. */
export function addToJobSummary(line: string, env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line);
}

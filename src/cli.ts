import type { AgentCli } from "./agent-cli.ts";
import { systemClock, type Clock } from "./clock.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, ConfigError, readSiteConfig } from "./config.ts";
import { ReviewError } from "./review/check.ts";
import { formatReport } from "./review/report.ts";
import { REVIEW_CHECKS, runReview } from "./review/review.ts";
import { LoopError, runTicketLoop } from "./ticket-loop.ts";
import type { Host } from "./host.ts";
import type { Tracker } from "./tracker.ts";

export interface FactoryDeps {
  cwd: string;
  /** The Builder's Agent CLI (the Claude Code adapter), or a fake in tests. */
  agentCli?: AgentCli;
  /** The Site's issues on GitHub (the GitHub tracker), or a fake in tests. */
  tracker?: Tracker;
  /** Missing until the Builder's host adapter exists. */
  host?: Host;
  /** The real clock unless a test fakes it. */
  clock?: Clock;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const USAGE = `Usage:
  factory loop <spec>             Build the open Tickets of Spec number <spec>, unattended
  factory review <url> [--json] [--check <id>]
                                  Run every Review check on the Site served at <url>,
                                  or only the ones named with --check
  factory --help                  Show this help

factory review checks every route its Site links to; a route is the URL's path
without query string and without a trailing slash (the root stays /). Run from a
Site's folder (where its factory.json is), it also runs the Site's own tests and
checks its dependencies for known advisories; anywhere else those two are not run.
Review checks: ${REVIEW_CHECKS.map((check) => check.id).join(", ")}.

Exit codes of factory review: 0 the Site Passes, 1 it did not pass, 2 wrong usage,
3 the review could not run (the Site could not be opened or the review stopped).
`;

/** The review could not measure the Site at all: neither a Pass nor a fail, so it gets a code of its own. */
const COULD_NOT_RUN = 3;

/** The `factory` command. Returns its exit code. */
export async function factory(argv: string[], deps: FactoryDeps): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === "review") return review(args, deps);
  if (command !== "loop") {
    deps.stderr(`factory does not know the command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const spec = Number(args[0]);
  if (args.length !== 1 || !Number.isInteger(spec) || spec <= 0) {
    deps.stderr(`factory loop needs the number of the Spec to build, for example: factory loop 12\n\n${USAGE}`);
    return 2;
  }
  return loop(spec, deps);
}

async function loop(spec: number, deps: FactoryDeps): Promise<number> {
  try {
    const config = await readSiteConfig(deps.cwd);
    if (!deps.agentCli || !deps.tracker || !deps.host) {
      deps.stderr("This version of the Factory cannot reach an Agent CLI or a host yet, so factory loop cannot run.\n");
      return 1;
    }
    const result = await runTicketLoop({
      siteDir: deps.cwd,
      spec,
      config,
      agentCli: deps.agentCli,
      tracker: deps.tracker,
      host: deps.host,
      clock: deps.clock ?? systemClock,
      log: (line) => deps.stdout(`${line}\n`),
    });
    const list = (tickets: number[]) => tickets.map((n) => `#${n}`).join(", ");
    if (result.parked.length > 0) {
      deps.stdout(`Parked, waiting for you: ${list(result.parked)}. Each Ticket says why; answer there, then run the loop again.\n`);
    }
    if (result.notPassed.length > 0) {
      deps.stdout(`Not passed: ${list(result.notPassed)}. The reason is on each Ticket.\n`);
    }
    if (result.blocked.length > 0) {
      deps.stdout(`Not started, waiting for a blocker: ${list(result.blocked.map((b) => b.ticket))}.\n`);
      for (const { ticket, reason } of result.blocked) deps.stdout(`  #${ticket}: ${reason}\n`);
    }
    const pr = result.pullRequest;
    if (pr) {
      deps.stdout(
        pr.opened
          ? `Spec #${spec} is built. Read its Preview at ${pr.preview}, then merge pull request #${pr.number} to Approve it: ${pr.url}\n`
          : `Spec #${spec} is built and its pull request #${pr.number} is up to date: ${pr.url}\n`,
      );
    }
    return result.parked.length + result.notPassed.length + result.blocked.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof LoopError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function review(args: string[], deps: FactoryDeps): Promise<number> {
  const json = args.includes("--json");
  const rest: string[] = [];
  const named: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") named.push(args[++i] ?? "");
    else if (args[i] !== "--json") rest.push(args[i]!);
  }
  const unknown = named.filter((id) => !REVIEW_CHECKS.some((check) => check.id === id));
  if (unknown.length > 0) {
    deps.stderr(`factory review has no Review check named ${unknown.map((id) => JSON.stringify(id)).join(", ")}.\n\n${USAGE}`);
    return 2;
  }
  const checks = named.length > 0 ? REVIEW_CHECKS.filter((check) => named.includes(check.id)) : REVIEW_CHECKS;
  const url = rest.length === 1 ? webAddress(rest[0]!) : undefined;
  if (!url) {
    deps.stderr(
      `factory review needs the full web address of a served Site, starting with http:// or https://, for example: factory review http://localhost:4321\n\n${USAGE}`,
    );
    return 2;
  }
  try {
    const repo = await access(join(deps.cwd, CONFIG_FILE)).then(() => deps.cwd, () => undefined);
    const report = await runReview(url, checks, repo);
    deps.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.passed ? 0 : 1;
  } catch (error) {
    deps.stderr(`${couldNotRun(error)}\n`);
    return COULD_NOT_RUN;
  }
}

/** One plain-language reason the review could not run, with no stack trace. */
function couldNotRun(error: unknown): string {
  if (error instanceof ReviewError) return error.message;
  const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return `The review stopped before it could check your whole Site (${detail}). Check that your Site is still being served, then run the review again.`;
}

function webAddress(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

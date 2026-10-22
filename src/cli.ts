import type { AgentCli } from "./agent-cli.ts";
import { systemClock, type Clock } from "./clock.ts";
import { ConfigError, readSiteConfig } from "./config.ts";
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
  factory loop <spec>   Build the open Tickets of Spec number <spec>, unattended
  factory --help        Show this help
`;

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

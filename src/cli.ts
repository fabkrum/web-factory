import type { AgentCli } from "./agent-cli.ts";
import { ConfigError, readSiteConfig } from "./config.ts";
import { LoopError, runTicketLoop } from "./ticket-loop.ts";
import type { Tracker } from "./tracker.ts";

export interface FactoryDeps {
  cwd: string;
  /** Missing until the Builder's Agent CLI adapter exists. */
  agentCli?: AgentCli;
  /** Missing until the GitHub tracker exists. */
  tracker?: Tracker;
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
    if (!deps.agentCli || !deps.tracker) {
      deps.stderr("This version of the Factory cannot reach an Agent CLI or GitHub yet, so factory loop cannot run.\n");
      return 1;
    }
    const result = await runTicketLoop({
      siteDir: deps.cwd,
      spec,
      config,
      agentCli: deps.agentCli,
      tracker: deps.tracker,
      log: (line) => deps.stdout(`${line}\n`),
    });
    const list = (tickets: number[]) => tickets.map((n) => `#${n}`).join(", ");
    if (result.parked.length > 0) {
      deps.stdout(`Parked, waiting for you: ${list(result.parked)}. Each Ticket says why; answer there, then run the loop again.\n`);
    }
    if (result.notPassed.length > 0) {
      deps.stdout(`Not passed: ${list(result.notPassed)}. The reason is on each Ticket.\n`);
    }
    return result.parked.length + result.notPassed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof LoopError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

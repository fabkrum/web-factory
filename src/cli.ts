import type { AgentCli } from "./agent-cli.ts";
import { systemClock, type Clock } from "./clock.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, ConfigError, readSiteConfig } from "./config.ts";
import { ReviewError } from "./review/check.ts";
import { couldNotRun, formatReport } from "./review/report.ts";
import { REVIEW_CHECKS, runReview } from "./review/review.ts";
import { BoardError, boardAddress, readBoard, serveBoard } from "./board.ts";
import { approveDesign, runDesign } from "./design.ts";
import { IMPORT_TOOLS, runDesignImport, type ImportTool } from "./design-import.ts";
import { KickoffError, runKickoff } from "./kickoff.ts";
import { PipelineError, runRequest } from "./request.ts";
import { confirmCut, runSpec } from "./spec.ts";
import { LoopError, runTicketLoop, type ReviewSite } from "./ticket-loop.ts";
import type { Host } from "./host.ts";
import { NotLoggedInError, type Tracker } from "./tracker.ts";

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
  /** Runs the Review checks on a Ticket's served build: every one of them, unless a test says otherwise. */
  reviewSite?: ReviewSite;
  /** Opens an address in the Builder's browser; missing, the Builder opens the printed address. */
  openBrowser?: (url: string) => void;
  /** Ends `factory board`; without it the board runs until the Builder stops the command. */
  stop?: AbortSignal;
  /** The environment, which tells whether this is a Codespace. */
  env?: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Where the board opens unless the Builder says otherwise; fixed, so a forwarded port stays the same. */
const BOARD_PORT = 4400;

export const USAGE = `Usage:
  factory kickoff <decisions-file>
                                  Record the Builder's Kickoff decisions, written down by
                                  the kickoff skill: ADRs, the Stack section in AGENTS.md,
                                  factory.json, and the Stage labels on GitHub
  factory request <request-file>  File the Builder's Request as an issue in the Request Stage;
                                  the request skill writes the file
  factory spec <spec-file>        Write the Spec on its Request's issue and file its Tickets
                                  in the Spec Stage; the spec skill writes the file. Run again
                                  with a changed file to replace the cut
  factory spec confirm <spec>     The Builder confirmed the cut: the Spec moves on to Design
  factory design <spec>           Make the Design handoff in design/ from the DESIGN.md and
                                  sample page the design skill wrote: generated tokens, a
                                  reference screenshot per route and a provenance record.
                                  Run again after any change
  factory design import <tool> <spec> [<where-it-came-from>]
                                  Make the Design handoff from what an import skill saved in
                                  .factory/design-import/<tool> and the DESIGN.md it wrote.
                                  <tool> is ${IMPORT_TOOLS.join(", ")}. Say where the design
                                  came from, such as its address; claude-design can do without
  factory design approve <spec>   The Builder approved the Design: its Tickets move to Build
  factory loop <spec>             Build the open Tickets of Spec number <spec>, unattended
  factory board [--json] [--port <port>]
                                  Open the board: every open Request and Ticket in its
                                  Stage, why anything is stuck, and the one next action.
                                  It runs until you stop it with Ctrl+C. --json prints
                                  the board's data once instead
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

const LOGIN_NEEDED = `Nothing is lost, but this is not on GitHub yet: your Requests, Specs and Tickets live as issues there, the way real teams track work, so this is the moment a GitHub login is needed.
Log in by running this in your own terminal, because it opens a browser: gh auth login
Then run this same command again.`;

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
  if (command === "kickoff") return kickoff(args, deps);
  if (command === "request") return request(args, deps);
  if (command === "spec") return spec(args, deps);
  if (command === "design") return design(args, deps);
  if (command === "board") return board(args, deps);
  if (command !== "loop") {
    deps.stderr(`factory does not know the command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const number = issueNumber(args[0]);
  if (args.length !== 1 || number === undefined) {
    deps.stderr(`factory loop needs the number of the Spec to build, for example: factory loop 12\n\n${USAGE}`);
    return 2;
  }
  return loop(number, deps);
}

function issueNumber(text: string | undefined): number | undefined {
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

async function request(args: string[], deps: FactoryDeps): Promise<number> {
  const [file] = args;
  if (file === undefined || args.length !== 1) {
    deps.stderr(`factory request needs the file with the Request: factory request <request-file>\n\n${USAGE}`);
    return 2;
  }
  return onTracker(deps, (tracker) => runRequest({ siteDir: deps.cwd, file, tracker, stdout: deps.stdout }));
}

async function spec(args: string[], deps: FactoryDeps): Promise<number> {
  if (args[0] === "confirm") {
    const number = issueNumber(args[1]);
    if (args.length !== 2 || number === undefined) {
      deps.stderr(`factory spec confirm needs the number of the Spec, for example: factory spec confirm 12\n\n${USAGE}`);
      return 2;
    }
    return onTracker(deps, (tracker) => confirmCut({ spec: number, tracker, stdout: deps.stdout }));
  }
  const [file] = args;
  if (file === undefined || args.length !== 1) {
    deps.stderr(`factory spec needs the file with the Spec: factory spec <spec-file>\n\n${USAGE}`);
    return 2;
  }
  return onTracker(deps, (tracker) => runSpec({ siteDir: deps.cwd, file, tracker, stdout: deps.stdout }));
}

async function designImport(args: string[], deps: FactoryDeps): Promise<number> {
  const [tool, specNumber, source] = args;
  const number = issueNumber(specNumber);
  const known = IMPORT_TOOLS.find((name) => name === tool);
  if (!known || number === undefined || args.length > 3 || (source === undefined && known !== "claude-design")) {
    deps.stderr(`factory design import needs the tool, the number of the Spec and where the design came from, for example: factory design import figma 12 https://www.figma.com/design/abc\n\n${USAGE}`);
    return 2;
  }
  return onTracker(deps, (tracker) => runDesignImport({ siteDir: deps.cwd, tool: known satisfies ImportTool, spec: number, source, tracker, clock: deps.clock ?? systemClock, stdout: deps.stdout }));
}

async function design(args: string[], deps: FactoryDeps): Promise<number> {
  if (args[0] === "import") return designImport(args.slice(1), deps);
  const approving = args[0] === "approve";
  const number = issueNumber(args[approving ? 1 : 0]);
  if (args.length !== (approving ? 2 : 1) || number === undefined) {
    deps.stderr(`factory design needs the number of the Spec, for example: factory design 12\n\n${USAGE}`);
    return 2;
  }
  if (approving) return onTracker(deps, (tracker) => approveDesign({ siteDir: deps.cwd, spec: number, tracker, stdout: deps.stdout }));
  return onTracker(deps, (tracker) => runDesign({ siteDir: deps.cwd, spec: number, tracker, clock: deps.clock ?? systemClock, stdout: deps.stdout }));
}

/** A step that writes to GitHub: what stops it is printed for the Builder, and running it again finishes it. */
async function onTracker(deps: FactoryDeps, step: (tracker: Tracker) => Promise<void>): Promise<number> {
  if (!deps.tracker) {
    deps.stderr("This version of the Factory cannot reach GitHub, so this command cannot run.\n");
    return 1;
  }
  try {
    await step(deps.tracker);
    return 0;
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      deps.stderr(`${LOGIN_NEEDED}\n`);
      return 1;
    }
    if (error instanceof PipelineError || error instanceof ConfigError || error instanceof ReviewError || error instanceof BoardError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    deps.stderr(`GitHub could not be reached, so this step is not finished: ${(error as Error).message}\nFix that, then run this same command again.\n`);
    return 1;
  }
}

async function board(args: string[], deps: FactoryDeps): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const port = rest.length === 0 ? BOARD_PORT : rest.length === 2 && rest[0] === "--port" && /^\d+$/.test(rest[1]!) ? Number(rest[1]) : undefined;
  if (port === undefined || port > 65535) {
    deps.stderr(`factory board takes only --json and --port with a port number, for example: factory board --port 4401\n\n${USAGE}`);
    return 2;
  }
  const clock = deps.clock ?? systemClock;
  return onTracker(deps, async (tracker) => {
    const read = () => readBoard({ siteDir: deps.cwd, tracker, clock });
    // Read once first, so a missing login is said here and not only on the page.
    const first = await read();
    if (json) {
      deps.stdout(`${JSON.stringify(first, null, 2)}\n`);
      return;
    }
    const env = deps.env ?? process.env;
    await serveBoard({
      read,
      port,
      now: () => clock.now(),
      stop: deps.stop,
      opened: (actualPort) => {
        const { url, codespace } = boardAddress(actualPort, env);
        deps.stdout(`The board is open at ${url}\nIt stays open until you press Ctrl+C here.\n`);
        if (!codespace) deps.openBrowser?.(url);
      },
    });
  });
}

async function kickoff(args: string[], deps: FactoryDeps): Promise<number> {
  const [file] = args;
  if (file === undefined || args.length !== 1) {
    deps.stderr(`factory kickoff needs the file with the Builder's decisions: factory kickoff <decisions-file>\n\n${USAGE}`);
    return 2;
  }
  if (!deps.tracker) {
    deps.stderr("This version of the Factory cannot reach GitHub, so factory kickoff cannot run.\n");
    return 1;
  }
  try {
    await runKickoff({ siteDir: deps.cwd, file, tracker: deps.tracker, stdout: deps.stdout });
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof KickoffError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
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
      reviewSite: deps.reviewSite ?? ((url, repo) => runReview(url, REVIEW_CHECKS, repo)),
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

function webAddress(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

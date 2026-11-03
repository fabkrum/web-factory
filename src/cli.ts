import type { AgentCli } from "./agent-cli.ts";
import { systemClock, type Clock } from "./clock.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, ConfigError, readLocalePack, readSiteConfig, type SiteConfig } from "./config.ts";
import { ReviewError } from "./review/check.ts";
import { couldNotRun, formatReport } from "./review/report.ts";
import { REVIEW_CHECKS, runReview } from "./review/review.ts";
import { currentBranch } from "./git.ts";
import { approveChange, runApprove } from "./approve.ts";
import { BoardError, boardAddress, readBoard, serveBoard } from "./board.ts";
import { approveDesign, runDesign } from "./design.ts";
import { IMPORT_TOOLS, runDesignImport, type ImportTool } from "./design-import.ts";
import { KickoffError, runKickoff } from "./kickoff.ts";
import { formatNextStep, whatIsNext } from "./next.ts";
import { PipelineError, runRequest } from "./request.ts";
import { confirmCut, runSpec } from "./spec.ts";
import { runUpdate } from "./update.ts";
import { LoopError, runTicketLoop, type ReviewSite } from "./ticket-loop.ts";
import { HostError, type Host } from "./host.ts";
import type { FactoryReleases } from "./releases.ts";
import { NotLoggedInError, type Tracker } from "./tracker.ts";
import { CruxError, type CruxSource } from "./crux.ts";
import { measureAfterPublish, runMeasure, type MeasureLab } from "./measure.ts";

export interface FactoryDeps {
  cwd: string;
  /** The Builder's Agent CLI (the Claude Code adapter), or a fake in tests. */
  agentCli?: AgentCli;
  /** The Site's issues on GitHub (the GitHub tracker), or a fake in tests. */
  tracker?: Tracker;
  /** Where the Factory is published (npm), or a fake in tests. */
  releases?: FactoryReleases;
  /** The adapter for the host in the Site's `factory.json`; missing when the Factory has none for it. */
  host?: Host;
  /** The real clock unless a test fakes it. */
  clock?: Clock;
  /** Runs the Review checks on a Ticket's served build: every one of them, unless a test says otherwise. */
  reviewSite?: ReviewSite;
  /** Runs Lighthouse on the live Site after a Publish; missing, Publish measures nothing. */
  measureLab?: MeasureLab;
  /** The Chrome UX Report; missing when no Google API key is set. */
  crux?: CruxSource;
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
  factory connect-host            Finish connecting the Site's host during Kickoff,
                                  after the kickoff skill's steps on the host's side
  factory publish                 Publish the Site live, then measure it with Lighthouse and
                                  compare with the previous measurement; merging into the
                                  base branch runs this on GitHub
  factory measure [<url>]         Check what real Visitors experience on the live Site in the
                                  Chrome UX Report (needs a Google API key in CRUX_API_KEY)
                                  and compare with the previous measurement. A measurement
                                  that got worse opens a new Request with the evidence
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
  factory approve <spec>          Approve Spec number <spec>: while its pull request is open
                                  this shows the Preview and the pull request; once the
                                  Builder merged it, the Spec moves to the Publish Stage
  factory approve change <spec> <change-file>
                                  The Builder asked for a change at Approve: a new Ticket
                                  in the Build Stage; the approve skill writes the file
  factory next [--json]           Say the one thing to do now and which skill to use
  factory board [--json] [--port <port>]
                                  Open the board: every open Request and Ticket in its
                                  Stage, why anything is stuck, and the one next action.
                                  It runs until you stop it with Ctrl+C. --json prints
                                  the board's data once instead
  factory review <url> [--json] [--check <id>]
                                  Run every Review check on the Site served at <url>,
                                  or only the ones named with --check
  factory update                  Bring the newest Factory into the Site as a pull request
                                  that lists what changed: skills, Review checks, Modern Web
                                  Guidance and the DESIGN.md format. Nothing in the Site
                                  changes until the Builder merges it
  factory --help                  Show this help

factory review checks every route its Site links to; a route is the URL's path
without query string and without a trailing slash (the root stays /). Run from a
Site's folder (where its factory.json is), it also runs the Site's own tests and
checks its dependencies for known advisories; anywhere else those two are not run.
The checks named legal/ are the German Locale pack: they run only on a Site whose
factory.json says "localePack": "de". None of the Review is legal advice.
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
  if (command === "connect-host") return connectHost(deps);
  if (command === "publish") return publish(deps);
  if (command === "request") return request(args, deps);
  if (command === "spec") return spec(args, deps);
  if (command === "design") return design(args, deps);
  if (command === "approve") return approve(args, deps);
  if (command === "next") return next(args, deps);
  if (command === "board") return board(args, deps);
  if (command === "update") return update(args, deps);
  if (command === "measure") return measure(args, deps);
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

async function approve(args: string[], deps: FactoryDeps): Promise<number> {
  if (args[0] === "change") {
    const number = issueNumber(args[1]);
    const file = args[2];
    if (args.length !== 3 || number === undefined || file === undefined) {
      deps.stderr(`factory approve change needs the number of the Spec and the file with the change, for example: factory approve change 12 .factory/change.json\n\n${USAGE}`);
      return 2;
    }
    return onTracker(deps, (tracker) => approveChange({ siteDir: deps.cwd, spec: number, file, tracker, stdout: deps.stdout }));
  }
  const number = issueNumber(args[0]);
  if (args.length !== 1 || number === undefined) {
    deps.stderr(`factory approve needs the number of the Spec, for example: factory approve 12\n\n${USAGE}`);
    return 2;
  }
  return onTracker(deps, (tracker) => runApprove({ spec: number, tracker, stdout: deps.stdout }));
}

async function next(args: string[], deps: FactoryDeps): Promise<number> {
  const json = args.includes("--json");
  if (args.some((arg) => arg !== "--json")) {
    deps.stderr(`factory next takes only --json.\n\n${USAGE}`);
    return 2;
  }
  return onTracker(deps, async (tracker) => {
    const step = await whatIsNext({ siteDir: deps.cwd, tracker, clock: deps.clock ?? systemClock });
    deps.stdout(json ? `${JSON.stringify(step, null, 2)}\n` : formatNextStep(step));
  });
}

async function update(args: string[], deps: FactoryDeps): Promise<number> {
  if (args.length > 0) {
    deps.stderr(`factory update takes nothing after it.\n\n${USAGE}`);
    return 2;
  }
  const { releases } = deps;
  if (!releases) {
    deps.stderr("This version of the Factory cannot reach npm, so factory update cannot run.\n");
    return 1;
  }
  return onTracker(deps, (tracker) => runUpdate({ siteDir: deps.cwd, tracker, releases, stdout: deps.stdout }));
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
    if (error instanceof PipelineError || error instanceof ConfigError || error instanceof ReviewError || error instanceof BoardError || error instanceof CruxError) {
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

const NO_HOST = "The Factory has no adapter for this Site's host, so it cannot do this. Follow the host's own setup in the Stack section of AGENTS.md.\n";

/** Runs a host step, printing why it stopped when it stopped for a reason the Builder can read. */
async function hostStep(deps: FactoryDeps, step: (host: Host, config: SiteConfig) => Promise<void>): Promise<number> {
  try {
    const config = await readSiteConfig(deps.cwd);
    if (!deps.host) {
      deps.stderr(NO_HOST);
      return 1;
    }
    await step(deps.host, config);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof HostError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function connectHost(deps: FactoryDeps): Promise<number> {
  return hostStep(deps, async (host, { baseBranch }) => {
    await host.connect({ siteDir: deps.cwd, baseBranch });
    deps.stdout(`The host is connected: merging into ${baseBranch} publishes the Site. Commit the changes and push them.\n`);
  });
}

function publish(deps: FactoryDeps): Promise<number> {
  return hostStep(deps, async (host, { baseBranch }) => {
    const branch = await currentBranch(deps.cwd);
    if (branch !== baseBranch) {
      throw new HostError(`Only ${baseBranch} is published, and this is ${branch}: nothing reaches the live Site without the Builder's Approve.`);
    }
    const live = await host.publishLive({ siteDir: deps.cwd });
    deps.stdout(`Published: ${live}\n`);
    await measurePublished(live, deps);
  });
}

/**
 * Lighthouse on the live Site after Publish. The Site is live whatever happens here, so a
 * measurement that cannot run is said, and Publish still succeeds.
 */
async function measurePublished(live: string, deps: FactoryDeps): Promise<void> {
  if (!deps.measureLab) return;
  if (!deps.tracker) {
    deps.stderr("The live Site is not measured: this version of the Factory cannot reach GitHub, where measurements are kept.\n");
    return;
  }
  try {
    await measureAfterPublish({ url: live, measureLab: deps.measureLab, tracker: deps.tracker, clock: deps.clock ?? systemClock, stdout: deps.stdout });
  } catch (error) {
    const reason = error instanceof NotLoggedInError ? "nobody is logged in to GitHub, where measurements are kept" : (error as Error).message;
    deps.stderr(`The Site is published, but measuring it did not finish: ${reason}\n`);
  }
}

async function measure(args: string[], deps: FactoryDeps): Promise<number> {
  const url = args.length === 1 ? webAddress(args[0]!) : undefined;
  if (args.length > 1 || (args.length === 1 && !url)) {
    deps.stderr(`factory measure takes at most the live Site's full web address, for example: factory measure https://my-site.web.app\n\n${USAGE}`);
    return 2;
  }
  return onTracker(deps, (tracker) => runMeasure({ url: url?.href, crux: deps.crux, tracker, clock: deps.clock ?? systemClock, stdout: deps.stdout }));
}

async function loop(spec: number, deps: FactoryDeps): Promise<number> {
  try {
    const config = await readSiteConfig(deps.cwd);
    if (!deps.agentCli || !deps.tracker || !deps.host) {
      deps.stderr("The Factory has no adapter for this Site's host or Agent CLI, so factory loop cannot run. It connects only Firebase Hosting itself.\n");
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
      reviewSite: deps.reviewSite ?? (async (url, repo) => runReview(url, REVIEW_CHECKS, repo, await readLocalePack(repo))),
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
          : `Spec #${spec} is built and its pull request #${pr.number} is up to date${pr.preview ? `, with a new Preview at ${pr.preview}` : ""}: ${pr.url}\n`,
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
    const localePack = repo ? await readLocalePack(repo) : undefined;
    const off = named.filter((id) => checks.some((check) => check.id === id && check.localePack && check.localePack !== localePack));
    if (off.length > 0) {
      deps.stderr(
        `${off.join(", ")} ${off.length === 1 ? "belongs" : "belong"} to the German Locale pack, which is off here. It runs from a Site's folder whose factory.json says "localePack": "de".\n`,
      );
      return 2;
    }
    const report = await runReview(url, checks, repo, localePack);
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

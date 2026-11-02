import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { renderBoard } from "./board-page.ts";
import type { Clock } from "./clock.ts";
import { LOCAL_DIR, readAllLoopStates, type TicketState } from "./loop-state.ts";
import { latestRunReports, runDetails, runSummary, type RunReport } from "./run-report.ts";
import { DECISION_STAGES, isStageLabel, STAGES, type Stage } from "./stages.ts";
import { lastPark } from "./ticket-loop.ts";
import type { OpenIssue, Tracker } from "./tracker.ts";

export interface Card {
  number: number;
  title: string;
  url: string;
  /** The Spec of a Ticket. */
  spec?: number;
  /** Missing when the Ticket parked on another machine and its park comment carries no count. */
  attempts?: number;
  /** Where the Ticket stands in the Ticket loop; missing when it is not in it. */
  status?: TicketState["status"];
  failingChecks: string[];
  /** A parked Ticket the Builder has answered, so it only waits for the Ticket loop. */
  answered?: boolean;
  /** Why it is stuck, in plain words. */
  reason?: string;
  /** While waiting on a rate limit: when the Ticket loop resumes, as an ISO time. */
  resumeAt?: string;
  /** The one thing to do now. */
  nextAction: string;
}

export interface Column {
  stage: Stage;
  kind: "decision" | "automatic";
  cards: Card[];
}

export interface Board {
  columns: Column[];
  /** Open issues with no Stage label, which no column can hold. */
  withoutStage: { number: number; title: string; url: string }[];
  /** The latest Run report of each Spec that has one, also of a Spec that is closed by now. */
  runReports: BoardRunReport[];
}

/** A Spec's latest Run report in plain words. */
export interface BoardRunReport {
  spec: number;
  /** Missing once the Spec is closed: only open issues reach the board. */
  title?: string;
  url?: string;
  finishedAt: string;
  summary: string;
  details: string;
}

/** A reason the board cannot open, said in plain words. */
export class BoardError extends Error {}

/** The board's data: the tracker says which Stage an issue is in, the loop's local state how a Ticket is doing. */
export async function readBoard({ siteDir, tracker, clock }: { siteDir: string; tracker: Tracker; clock: Clock }): Promise<Board> {
  const localDir = join(siteDir, LOCAL_DIR);
  const [issues, states, reports] = await Promise.all([tracker.openIssues(), readAllLoopStates(localDir), latestRunReports(localDir)]);
  const columns: Column[] = STAGES.map((stage) => ({ stage, kind: DECISION_STAGES.includes(stage) ? "decision" : "automatic", cards: [] }));
  const withoutStage: Board["withoutStage"] = [];
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const stage = stageOf(issue);
    if (!stage) {
      withoutStage.push({ number: issue.number, title: issue.title, url: issue.url });
      continue;
    }
    const local = states.get(issue.number);
    const card = await cardOf(issue, stage, local?.state, issue.parent ?? local?.spec, tracker, clock);
    columns.find((column) => column.stage === stage)!.cards.push(card);
  }
  // A Spec in Build moves with its Tickets, and each of those says what to do.
  const specsWithTickets = new Set(columns.flatMap((column) => column.cards.map((card) => card.spec)));
  for (const card of columns.find((column) => column.stage === "build")!.cards) {
    if (card.spec === undefined && specsWithTickets.has(card.number)) card.nextAction = "Nothing to do on this Spec: its Tickets show where it stands.";
  }
  return { columns, withoutStage, runReports: reports.map((report) => boardReport(report, issues)) };
}

function boardReport(report: RunReport, issues: OpenIssue[]): BoardRunReport {
  const issue = issues.find((candidate) => candidate.number === report.spec);
  return {
    spec: report.spec,
    ...(issue ? { title: issue.title, url: issue.url } : {}),
    finishedAt: report.finishedAt,
    summary: runSummary(report),
    details: runDetails(report),
  };
}

function stageOf(issue: OpenIssue): Stage | undefined {
  const label = issue.labels.find(isStageLabel)?.toLowerCase();
  return STAGES.find((stage) => label === `stage:${stage}`);
}

async function cardOf(issue: OpenIssue, stage: Stage, recorded: TicketState | undefined, spec: number | undefined, tracker: Tracker, clock: Clock): Promise<Card> {
  const isTicket = issue.parent !== undefined || recorded !== undefined;
  const base = { number: issue.number, title: issue.title, url: issue.url, ...(spec === undefined ? {} : { spec }), attempts: recorded?.attempts ?? 0 };
  const inLoop = stage === "build" && isTicket;
  const state = inLoop ? await withParkFromTracker(issue, recorded, tracker) : undefined;
  const failing = { failingChecks: (state ?? recorded)?.failingChecks ?? [] };
  if (!inLoop) return { ...base, ...failing, nextAction: stageAction(stage, issue, isTicket) };
  if (!state) return { ...base, ...failing, nextAction: `Start the Ticket loop: ${loopCommand(spec)}` };
  // A Pass reopened by hand is no longer a Pass: to the loop it is a Ticket to build again.
  if (state.status === "passed") return { ...base, ...failing, nextAction: `Run the Ticket loop again: ${loopCommand(spec)}` };
  const wasAnswered = await answered(issue, state, tracker);
  return {
    ...base,
    ...failing,
    attempts: state.attempts,
    status: state.status,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    ...(state.resumeAt === undefined ? {} : { resumeAt: state.resumeAt }),
    ...(wasAnswered ? { answered: true } : {}),
    nextAction: loopAction(issue, state, wasAnswered, spec, clock),
  };
}

/** A Ticket's state as the board knows it: the count can be missing for a Ticket parked elsewhere. */
type KnownState = Omit<TicketState, "attempts"> & { attempts?: number };

/**
 * The tracker holds the park comment, so a Ticket parked on another machine, whose local
 * state is not here, still shows as parked with its reason and attempt count, also once
 * the Builder answered it.
 */
async function withParkFromTracker(issue: OpenIssue, recorded: TicketState | undefined, tracker: Tracker): Promise<KnownState | undefined> {
  if (recorded) return recorded;
  const parked = lastPark(await tracker.historyOf(issue.number));
  if (!parked) return undefined;
  return { status: "parked", reason: parked.reason, ...(parked.attempts === undefined ? {} : { attempts: parked.attempts }) };
}

/** Whether something happened on a parked Ticket since its park comment; the tracker decides that, not the local state. */
async function answered(issue: OpenIssue, state: KnownState, tracker: Tracker): Promise<boolean> {
  if (state.status !== "parked") return false;
  const parked = lastPark(await tracker.historyOf(issue.number));
  return parked === undefined || parked.since.length > 0;
}

function loopCommand(spec: number | undefined): string {
  return `factory loop ${spec ?? "<the number of its Spec>"}`;
}

function loopAction(issue: OpenIssue, state: KnownState, wasAnswered: boolean, spec: number | undefined, clock: Clock): string {
  const again = loopCommand(spec);
  switch (state.status) {
    case "parked":
      return wasAnswered ? `You answered on the Ticket, so run the Ticket loop again: ${again}` : `Answer in a comment on Ticket #${issue.number}, then run: ${again}`;
    case "waiting":
      return state.resumeAt !== undefined && Date.parse(state.resumeAt) <= clock.now().getTime()
        ? `It should have resumed by now. If the Ticket loop stopped, run: ${again}`
        : "Nothing to do: the Ticket loop resumes by itself.";
    case "blocked":
      return `Nothing to do on this Ticket until its blocker passes. Then run: ${again}`;
    case "not-passed":
      return `Read the reason, then run: ${again}`;
    default:
      return `Nothing to do while the Ticket loop runs. If it stopped, run: ${again}`;
  }
}

/** What an issue outside the Ticket loop needs next, which only its Stage decides. */
function stageAction(stage: Stage, issue: OpenIssue, isTicket: boolean): string {
  if (isTicket && (stage === "spec" || stage === "design" || stage === "approve")) {
    return `Nothing to do on this Ticket: it moves on with its Spec${issue.parent === undefined ? "" : ` #${issue.parent}`}.`;
  }
  switch (stage) {
    case "request":
      return "Ask your Agent CLI to use the spec skill, which works this Request out into a Spec.";
    case "spec":
      return `Read the cut into Tickets, then confirm it: factory spec confirm ${issue.number}`;
    case "design":
      return "Ask your Agent CLI to use the design skill, then approve the Design.";
    case "build":
      return `Run the Ticket loop: ${loopCommand(issue.number)}`;
    case "approve":
      return "Ask your Agent CLI to use the approve skill, which walks you through reading the Preview and merging the pull request.";
    default:
      return "Nothing to do: this Stage runs by itself.";
  }
}

/** Where the Builder opens a board on this port: on a Codespace, the forwarded address. */
export function boardAddress(port: number, env: NodeJS.ProcessEnv): { url: string; codespace: boolean } {
  const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = env;
  if (env.CODESPACES === "true" && name && domain) return { url: `https://${name}-${port}.${domain}/`, codespace: true };
  return { url: `http://localhost:${port}/`, codespace: env.CODESPACES === "true" };
}

/**
 * Serves the board until `stop` fires. It listens on this machine only, since it shows the
 * Site's issues; a Codespace forwards such a port by itself, privately to its owner.
 */
export async function serveBoard(options: {
  read: () => Promise<Board>;
  port: number;
  now: () => Date;
  stop?: AbortSignal;
  opened: (port: number) => void;
}): Promise<void> {
  const { read, port, now, stop, opened } = options;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://board").pathname;
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (request.method !== "GET" || path !== "/") {
      response.writeHead(404, headers);
      response.end("Not found");
      return;
    }
    read().then(
      (board) => {
        response.writeHead(200, headers);
        response.end(renderBoard(board, now()));
      },
      (error: Error) => {
        response.writeHead(503, headers);
        response.end(renderBoard({ columns: [], withoutStage: [], runReports: [] }, now(), `GitHub could not be reached, so the board cannot show your work right now: ${error.message}`));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new BoardError(`Port ${port} is already in use, perhaps by a board that is still open. Use that one, or open this one on another port: factory board --port ${port + 1}`)
          : error,
      ),
    );
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  opened(typeof address === "object" && address ? address.port : port);
  await new Promise<void>((resolve) => {
    if (stop?.aborted) resolve();
    stop?.addEventListener("abort", () => resolve(), { once: true });
    // Without a stop signal this waits on: Ctrl+C ends the process.
  });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** Opens the Builder's browser where this system has a way to; the printed address is the fallback, so a failure stays quiet. */
export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.env.WSL_DISTRO_NAME ? "wslview" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

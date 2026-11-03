import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentCliChoice, readSiteConfig } from "./config.ts";
import { AGENTS_FILE, findStackSection, kickoffRecorded } from "./decision-record.ts";
import { ghCli, type Gh } from "./github-tracker.ts";
import { LOCAL_DIR } from "./loop-state.ts";
import { parkKind, type ParkKind } from "./measure-factory.ts";
import { factoryPin } from "./pins.ts";
import { PipelineError } from "./request.ts";
import { REVIEW_CHECKS } from "./review/review.ts";
import { duration, readRunReports, type RunReport } from "./run-report.ts";
import { redactDeep } from "./secrets.ts";
import { NotLoggedInError } from "./tracker.ts";

/**
 * Factory feedback (ADR 0006): after a run with several parked Tickets, the Builder may send an
 * anonymised summary of it to the Factory's maintainers, as an issue on the Factory's repository.
 * It holds the setup and what happened, counted: no code, no Site content, no Ticket titles, no
 * reasons in the sessions' own words. It is only ever sent by the Builder, after reading all of
 * it: sending needs the code shown with exactly that content.
 */

/** Where Factory feedback goes: the Factory's public repository. */
export const FACTORY_REPOSITORY = "fabkrum/web-factory";

/** From this many parked Tickets in one run, the Ticket loop offers Factory feedback. */
export const SEVERAL_PARKED = 2;

/** The boundary to the Factory's repository; a test fakes it. */
export interface FeedbackChannel {
  /** Files the feedback as an issue and returns its address. */
  fileIssue(issue: { title: string; body: string }): Promise<string>;
}

/** Files Factory feedback through the GitHub CLI, logged in as the Builder. */
export class GitHubFeedback implements FeedbackChannel {
  readonly #gh: Gh;
  readonly #cwd: string;

  constructor(options: { cwd: string; gh?: Gh }) {
    this.#cwd = options.cwd;
    this.#gh = options.gh ?? ghCli();
  }

  async fileIssue(issue: { title: string; body: string }): Promise<string> {
    const args = ["api", "-X", "POST", `repos/${FACTORY_REPOSITORY}/issues`, "-H", "Accept: application/vnd.github+json", "--input", "-"];
    try {
      const created = JSON.parse(await this.#gh(args, { cwd: this.#cwd, input: JSON.stringify(redactDeep(issue)) })) as { html_url?: string };
      return created.html_url ?? `https://github.com/${FACTORY_REPOSITORY}/issues`;
    } catch (error) {
      if (error instanceof Error && /gh auth login/.test(error.message)) throw new NotLoggedInError(error.message);
      throw error;
    }
  }
}

const PARK_WORDS: Record<ParkKind | "earlier", string> = {
  decision: "a session needed a decision from the Builder",
  "review-checks": "Review checks kept failing",
  "time-limit": "sessions ran past their time limit",
  "code-review": "the code review kept sending it back",
  "session-failed": "the Agent CLI's sessions failed",
  gate: "it did not get past the gate (tests red or no usable commit)",
  earlier: "parked in an earlier run and not answered yet",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The setup of the Site, as far as Factory feedback says it. */
interface Setup {
  factoryVersion?: string;
  agentCli: string;
  stack?: string;
  maxAttempts?: number;
  sessionTimeoutMs?: number;
}

async function readSetup(siteDir: string): Promise<Setup> {
  const read = (file: string) => readFile(join(siteDir, file), "utf8").catch(() => undefined);
  const agents = await read(AGENTS_FILE);
  const section = agents !== undefined && kickoffRecorded(agents) ? findStackSection(agents)?.body : undefined;
  // The stack's name only, the way Kickoff wrote it, never the rest of the section.
  const stack = /^- Stack: (.+)$/m.exec(section ?? "")?.[1]?.trim().slice(0, 80);
  const config = await readSiteConfig(siteDir).catch(() => undefined);
  const factoryVersion = factoryPin(await read("package.json"));
  return {
    ...(factoryVersion ? { factoryVersion } : {}),
    agentCli: await readAgentCliChoice(siteDir).catch(() => "not known"),
    ...(stack ? { stack } : {}),
    ...(config ? { maxAttempts: config.maxAttempts, sessionTimeoutMs: config.sessionTimeoutMs } : {}),
  };
}

/** A failing check by its Factory name; a name the Factory does not know could carry anything, so it is not repeated. */
function checkName(name: string): string {
  return REVIEW_CHECKS.some((check) => check.name === name) ? name : "a check this Factory version does not know";
}

/** The feedback for one run: everything that would be sent, and nothing else. */
export function feedbackFor(report: RunReport, setup: Setup): { title: string; body: string } {
  const { tickets } = report;
  const of = (outcome: string) => tickets.filter((ticket) => ticket.outcome === outcome).length;
  const parked = tickets.filter((ticket) => ticket.outcome === "parked");
  const why = new Map<string, number>();
  for (const ticket of parked) {
    const words = PARK_WORDS[parkKind(ticket) ?? "earlier"];
    why.set(words, (why.get(words) ?? 0) + 1);
  }
  const checks = new Map<string, Set<number>>();
  for (const ticket of tickets) {
    for (const name of ticket.failedAttempts.flatMap((attempt) => attempt.failingChecks)) {
      const known = checkName(name);
      checks.set(known, (checks.get(known) ?? new Set()).add(ticket.ticket));
    }
  }
  const outcomes = [
    ...(of("passed") > 0 ? [`${of("passed")} passed`] : []),
    ...(parked.length > 0 ? [`${parked.length} parked`] : []),
    ...(of("not-passed") > 0 ? [`${of("not-passed")} not passed`] : []),
    ...(of("blocked") > 0 ? [`${of("blocked")} waiting for a blocker`] : []),
    ...(of("unfinished") > 0 ? [`${of("unfinished")} unfinished`] : []),
  ];
  const limit = setup.sessionTimeoutMs === undefined ? [] : [`- Session time limit: ${duration(setup.sessionTimeoutMs)}`];
  return {
    title: `Factory feedback: ${count(parked.length, "Ticket")} of ${tickets.length} parked with ${setup.agentCli}`,
    body: [
      "Factory feedback from a Builder, sent by the Builder after reading all of it. It holds no code, no Site content, no Ticket titles and no reasons in the sessions' own words: only the setup and what happened in one run of the Ticket loop, counted.",
      "",
      "## Setup",
      "",
      `- Factory version: ${setup.factoryVersion ?? "not pinned"}`,
      `- Agent CLI: ${setup.agentCli}`,
      `- Stack: ${setup.stack ?? "not recorded"}`,
      ...(setup.maxAttempts === undefined ? [] : [`- Attempts per Ticket: ${setup.maxAttempts}`]),
      ...limit,
      "",
      "## The run",
      "",
      `- Tickets: ${tickets.length}${outcomes.length > 0 ? ` (${outcomes.join(", ")})` : ""}`,
      `- Fix rounds: ${tickets.reduce((total, ticket) => total + ticket.fixRounds, 0)}`,
      `- Tickets with flaky tests: ${tickets.filter((ticket) => ticket.flaky.length > 0).length}`,
      `- Waited on rate limits: ${duration(report.rateLimitWaitMs)}`,
      ...(report.stopped === undefined ? [] : ["- The run stopped before it was through"]),
      "",
      "## Why Tickets parked",
      "",
      ...(why.size > 0 ? [...why].map(([words, n]) => `- ${count(n, "Ticket")}: ${words}`) : ["- None parked"]),
      "",
      "## Review checks that failed",
      "",
      ...(checks.size > 0 ? [...checks].map(([name, on]) => `- ${name}: on ${count(on.size, "Ticket")}`) : ["- None"]),
      "",
    ].join("\n"),
  };
}

/** The code that confirms the Builder read exactly this content: it changes with every character. */
export function confirmationCode(feedback: { title: string; body: string }): string {
  return createHash("sha256").update(`${feedback.title}\n${feedback.body}`).digest("hex").slice(0, 8);
}

/** The newest Run report of a Spec. */
async function latestRunOf(siteDir: string, spec: number): Promise<RunReport> {
  const report = (await readRunReports(join(siteDir, LOCAL_DIR))).filter((candidate) => candidate.spec === spec).at(-1);
  if (!report) throw new PipelineError(`Spec #${spec} has no Run report on this machine yet, so there is no run to send feedback about. The Ticket loop writes one after every run: factory loop ${spec}`);
  return report;
}

/** Whether the Ticket loop offers Factory feedback after this run. */
export function offersFeedback(report: RunReport): boolean {
  return report.tickets.filter((ticket) => ticket.outcome === "parked").length >= SEVERAL_PARKED;
}

export const offerText = (spec: number) =>
  `Several Tickets parked in this run. You can help improve the Factory by sending its maintainers Factory feedback: a summary of this run without your code or content. Nothing is sent unless you send it. To read exactly what it would contain: factory feedback ${spec}\n`;

/** `factory feedback <spec>`: shows all of the feedback and the code that sends exactly it. Sends nothing. */
export async function showFeedback(options: { siteDir: string; spec: number; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, spec, stdout } = options;
  const feedback = feedbackFor(await latestRunOf(siteDir, spec), await readSetup(siteDir));
  stdout(`This is everything Factory feedback about the last run of Spec #${spec} would send. It would become an issue on the Factory's repository, github.com/${FACTORY_REPOSITORY}, which anyone can read.

----- Title -----
${feedback.title}
----- Body -----
${feedback.body}----- End -----

Nothing is sent yet. To send exactly this, run: factory feedback ${spec} send ${confirmationCode(feedback)}
`);
}

type Sent = Record<string, string>;
const sentFile = (siteDir: string) => join(siteDir, LOCAL_DIR, "factory-feedback-sent.json");

/** `factory feedback <spec> send <code>`: sends the feedback, only when it is still exactly what the code was shown with. */
export async function sendFeedback(options: { siteDir: string; spec: number; code: string; channel: FeedbackChannel; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, spec, code, channel, stdout } = options;
  const feedback = feedbackFor(await latestRunOf(siteDir, spec), await readSetup(siteDir));
  if (confirmationCode(feedback) !== code) {
    throw new PipelineError(`Nothing was sent: the code ${code} does not belong to the feedback as it stands now, so you have not read this version of it. Read it again with factory feedback ${spec}, then send it with the code shown there.`);
  }
  const sent: Sent = await readFile(sentFile(siteDir), "utf8").then((text) => JSON.parse(text) as Sent, () => ({}));
  if (sent[code]) {
    stdout(`This feedback was already sent, as ${sent[code]}. Nothing was sent again.\n`);
    return;
  }
  const url = await channel.fileIssue(feedback);
  sent[code] = url;
  await mkdir(join(siteDir, LOCAL_DIR), { recursive: true });
  await writeFile(`${sentFile(siteDir)}.tmp`, `${JSON.stringify(sent, null, 2)}\n`);
  await rename(`${sentFile(siteDir)}.tmp`, sentFile(siteDir));
  stdout(`Thank you: your Factory feedback is sent, as ${url}\n`);
}

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adrPath, AGENTS_FILE, commitRecord, fieldReader, findStackSection, hasSectionHeading, readSkillFile, renderAdr, withStackSection, writeAdr, type Choice } from "./decision-record.ts";
import { PipelineError } from "./request.ts";
import { stageLabel } from "./stages.ts";
import type { Issue, Tracker } from "./tracker.ts";

/** A later Architecture decision, raised by a Request that touches the Site's architecture. */
interface ArchitectureDecision extends Choice {
  title: string;
}

interface CutTicket {
  title: string;
  delivers: string;
  acceptance: string[];
  /** Positions in the cut, counted from 1, as the Builder sees them. */
  blockedBy: number[];
}

/** What the spec skill writes after questioning the Builder. */
interface SpecFile {
  request: number;
  title: string;
  shouldDo: string;
  howToTell: string[];
  architectureDecision: ArchitectureDecision | null;
  tickets: CutTicket[];
}

const refuse = (message: string) => new PipelineError(message);
const { text, record, choice } = fieldReader("The Spec's file and its fields", refuse);

/** Heads the Builder's own words in a Spec; a changed cut finds them again by it. */
const REQUEST_HEADING = "## The Request, in the Builder's words";
const NOTHING_DECIDED = "Not decided yet";

function list(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw refuse(`The Spec's file and its fields have no ${field}.`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function cutTicket(value: unknown, position: number, size: number): CutTicket {
  const name = `tickets[${position - 1}]`;
  const ticket = record(value, name);
  const blockedBy = ticket.blockedBy ?? [];
  if (!Array.isArray(blockedBy)) throw refuse(`${name}.blockedBy must list positions in the cut, such as [1, 2].`);
  for (const blocker of blockedBy) {
    if (!Number.isInteger(blocker) || blocker < 1 || blocker > size || blocker === position) {
      throw refuse(`Ticket ${position} of the cut names ${JSON.stringify(blocker)} as its blocker, which is not another Ticket of this cut.`);
    }
  }
  return {
    title: text(ticket.title, `${name}.title`),
    delivers: text(ticket.delivers, `${name}.delivers`),
    acceptance: list(ticket.acceptance, `${name}.acceptance`),
    blockedBy: blockedBy as number[],
  };
}

/** Tickets that block each other in a circle could never start, and the Ticket loop would wait for ever. */
function refuseCircle(tickets: CutTicket[]): void {
  const done = new Set<number>();
  while (done.size < tickets.length) {
    const free = tickets.findIndex((ticket, index) => !done.has(index + 1) && ticket.blockedBy.every((blocker) => done.has(blocker)));
    if (free === -1) {
      const stuck = tickets.map((_, index) => index + 1).filter((position) => !done.has(position));
      throw refuse(`Tickets ${stuck.join(", ")} of the cut block each other in a circle, so none of them could ever start. Change their blockers.`);
    }
    done.add(free + 1);
  }
}

/** Checks everything before anything is written, so a refusal changes nothing. */
function parseSpec(raw: unknown): SpecFile {
  const spec = record(raw, "content");
  const { request } = spec;
  if (!Number.isInteger(request) || (request as number) <= 0) throw refuse("The Spec's file names no Request: `request` must be the number of its issue.");
  if (spec.architectureDecision === undefined) {
    throw refuse("The Spec's file does not say whether the Request touches the Site's architecture: set `architectureDecision` to the Builder's decision, or to null when it touches none.");
  }
  if (!Array.isArray(spec.tickets) || spec.tickets.length === 0) throw refuse("The Spec's file holds no Tickets: a Spec is cut into at least one.");
  const size = spec.tickets.length;
  const tickets = spec.tickets.map((ticket, index) => cutTicket(ticket, index + 1, size));
  refuseCircle(tickets);
  const decision = spec.architectureDecision === null ? null : record(spec.architectureDecision, "architectureDecision");
  return {
    request: request as number,
    title: text(spec.title, "title"),
    shouldDo: text(spec.shouldDo, "shouldDo"),
    howToTell: list(spec.howToTell, "howToTell"),
    architectureDecision: decision && { title: text(decision.title, "architectureDecision.title"), ...choice(decision, "architectureDecision") },
    tickets,
  };
}

function bullets(items: string[], box = ""): string {
  return items.map((item) => `- ${box}${item}`).join("\n");
}

/** The Builder's words: all of a Request's body, or what a Spec already keeps of them. */
function builderWords(body: string): string {
  const heading = body.lastIndexOf(`${REQUEST_HEADING}\n`);
  return heading === -1 ? body : body.slice(heading + REQUEST_HEADING.length).trim();
}

function specBody(spec: SpecFile, words: string, adr: string | undefined): string {
  const decision = spec.architectureDecision;
  return [
    `## What it should do\n\n${spec.shouldDo}`,
    `## How to tell that it does\n\n${bullets(spec.howToTell)}`,
    ...(decision ? [`## Architecture decision\n\n${decision.title}: the Builder chose ${decision.chosen}. ${decision.reason} The options offered are in \`${adr}\`.`] : []),
    `${REQUEST_HEADING}\n\n${words}`,
  ].join("\n\n");
}

function ticketBody(ticket: CutTicket, spec: number): string {
  return `Part of #${spec}.\n\n## What to build\n\n${ticket.delivers}\n\n## Acceptance criteria\n\n${bullets(ticket.acceptance, "[ ] ")}`;
}

/** Writes and commits the ADR and points the Stack section at it, so every later session builds that way. */
async function recordDecision(siteDir: string, spec: SpecFile, decision: ArchitectureDecision, words: string): Promise<string> {
  let agents: string;
  try {
    agents = await readFile(join(siteDir, AGENTS_FILE), "utf8");
  } catch {
    throw refuse(`This folder has no ${AGENTS_FILE}, so it is not a Site. Run factory from your Site's folder.`);
  }
  const section = findStackSection(agents);
  if (!section || section.body.startsWith(NOTHING_DECIDED)) {
    throw refuse("This Site has had no Kickoff yet, so there is no architecture for this decision to change. Follow the kickoff skill first.");
  }
  const path = await adrPath(siteDir, decision.title);
  const line = `Later Architecture decision: ${decision.title}: ${decision.chosen}. It replaces anything above that it contradicts; see \`${path}\`.`;
  if (hasSectionHeading(line)) throw refuse("architectureDecision.title holds a line starting with \"## \". Write it without one.");
  await writeAdr(siteDir, path, renderAdr(decision.title, `Raised by Request #${spec.request}: ${words}`, decision));
  if (!section.body.includes(`\`${path}\``)) {
    await writeFile(join(siteDir, AGENTS_FILE), withStackSection(agents, `${section.body}\n\n${line}`));
  }
  await commitRecord(siteDir, [AGENTS_FILE, path], `Record the Architecture decision: ${decision.title}`);
  return path;
}

function cutInPlainWords(spec: SpecFile, filed: { number: number }[]): string {
  const name = (position: number) => `#${filed[position - 1]!.number} ${spec.tickets[position - 1]!.title}`;
  const lines = spec.tickets.flatMap((ticket, index) => [
    name(index + 1),
    `  Delivers: ${ticket.delivers}`,
    `  Blocked by: ${ticket.blockedBy.length > 0 ? ticket.blockedBy.map(name).join("; ") : "nothing, it can start right away"}`,
  ]);
  return `${lines.join("\n")}\n`;
}

/**
 * Turns a Request's issue into its Spec and files the cut. The issue carries the Spec Stage label
 * only while a whole cut stands behind it: it steps back to the Request Stage while the cut is
 * replaced, so running again finishes a run that stopped, and a half-filed cut cannot be confirmed.
 */
export async function runSpec(options: { siteDir: string; file: string; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, file, tracker, stdout } = options;
  const spec = parseSpec(await readSkillFile(siteDir, file, "spec", refuse));
  const issue = await tracker.getIssue(spec.request);
  if (issue.state === "closed") throw refuse(`#${issue.number} is closed, so it cannot become a Spec.`);
  if (!inStage(issue, "request") && !inStage(issue, "spec")) {
    throw refuse(`#${issue.number} is past the Spec Stage, so its cut is confirmed and stays. To change what it does, file a new Request.`);
  }
  const words = builderWords(issue.body);
  const adr = spec.architectureDecision ? await recordDecision(siteDir, spec, spec.architectureDecision, words) : undefined;

  await tracker.moveToStage(issue.number, "request");
  for (const old of await tracker.ticketsOf(issue.number)) await tracker.removeTicket(issue.number, old.number);
  const filed: { number: number }[] = [];
  for (const ticket of spec.tickets) {
    filed.push({ number: await tracker.createIssue({ title: ticket.title, body: ticketBody(ticket, issue.number), stage: "spec", parent: issue.number }) });
  }
  for (const [index, ticket] of spec.tickets.entries()) {
    for (const blocker of ticket.blockedBy) await tracker.addBlocker(filed[index]!.number, filed[blocker - 1]!.number);
  }
  await tracker.updateIssue(issue.number, { title: spec.title, body: specBody(spec, words, adr) });
  await tracker.moveToStage(issue.number, "spec");

  stdout(`Spec #${issue.number} is written: ${spec.title}. Its Tickets wait in the Spec Stage, and nothing is built until you confirm this cut.\n\n`);
  stdout(cutInPlainWords(spec, filed));
  if (adr) stdout(`\nThe Architecture decision is recorded in ${adr} and committed. Run git push so that GitHub has it.\n`);
  stdout(`\nOnce you confirm the cut: factory spec confirm ${issue.number}\nTo change it: change the file and run factory spec again.\n`);
}

function inStage(issue: Issue, stage: "request" | "spec" | "design"): boolean {
  return issue.labels.some((label) => label.toLowerCase() === stageLabel(stage));
}

/** The Builder confirmed the cut: the Spec moves to Design. Its Tickets stay put until the Design is approved. */
export async function confirmCut(options: { spec: number; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { spec, tracker, stdout } = options;
  const issue = await tracker.getIssue(spec);
  const next = `Next step: Design. The Tickets go to the Ticket loop only once you approve the Design.\n`;
  if (inStage(issue, "design")) {
    stdout(`The cut of Spec #${spec} is already confirmed. ${next}`);
    return;
  }
  if (!inStage(issue, "spec") || issue.state === "closed") {
    throw refuse(`#${spec} is not a Spec waiting in the Spec Stage, so there is no cut to confirm. If factory spec stopped halfway, run it again.`);
  }
  if ((await tracker.ticketsOf(spec)).filter((ticket) => ticket.state === "open").length === 0) {
    throw refuse(`#${spec} has no open Tickets, so there is no cut to confirm. If it is a Ticket, confirm its Spec instead.`);
  }
  await tracker.moveToStage(spec, "design");
  stdout(`The cut of Spec #${spec} is confirmed. ${next}`);
}

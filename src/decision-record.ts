import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.ts";

/** One option the Builder was offered, with the case for and against it. */
export interface Option {
  name: string;
  for: string;
  against: string;
}

/** One Architecture decision: what was offered, what the model recommended, what the Builder chose and why. */
export interface Choice {
  chosen: string;
  recommended: string;
  reason: string;
  options: Option[];
}

export const AGENTS_FILE = "AGENTS.md";
const ADR_FOLDER = "docs/adr";
const SECTION_HEADING = /^## /m;

export function hasSectionHeading(text: string): boolean {
  return SECTION_HEADING.test(text);
}

/** Reads the fields of a file a skill wrote; each refusal names the file and is printed as it is. */
export function fieldReader(source: string, fail: (message: string) => Error) {
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "") throw fail(`${source} have no ${field}.`);
    return value;
  };
  const record = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null) throw fail(`${source} have no ${field}.`);
    return value as Record<string, unknown>;
  };
  const choice = (value: unknown, field: string): Choice => {
    const raw = record(value, field);
    if (!Array.isArray(raw.options) || raw.options.length < 2) {
      throw fail(`${source} offer the Builder fewer than two options for ${field}, and it takes at least two to make a choice.`);
    }
    const options = raw.options.map((option: unknown, index) => {
      const entry = record(option, `${field}.options[${index}]`);
      const name = text(entry.name, `${field}.options[${index}].name`);
      return { name, for: text(entry.for, `case for ${name} (${field})`), against: text(entry.against, `case against ${name} (${field})`) };
    });
    const offered = (name: string, role: string): string => {
      if (!options.some((option) => option.name === name)) throw fail(`${source} name ${name} as ${role} ${field}, but it is not among the options offered.`);
      return name;
    };
    return {
      chosen: offered(text(raw.chosen, `${field}.chosen`), "the chosen"),
      recommended: offered(text(raw.recommended, `${field}.recommended`), "the recommended"),
      reason: text(raw.reason, `${field}.reason`),
      options,
    };
  };
  return { text, record, choice };
}

/** The content of a JSON file a skill wrote. */
export async function readSkillFile(siteDir: string, file: string, skill: string, fail: (message: string) => Error): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(resolve(siteDir, file), "utf8");
  } catch {
    throw fail(`${file} could not be read. It is the file the ${skill} skill writes.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(`${file} is not valid JSON.`);
  }
}

/** An ADR: `context` says why the decision came up, then what was chosen and everything offered. */
export function renderAdr(title: string, context: string, decision: Choice, consequence?: string): string {
  const options = decision.options.map((option) => {
    const marks = [option.name === decision.chosen ? "chosen" : "", option.name === decision.recommended ? "recommended" : ""].filter(Boolean);
    return `### ${option.name}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}\n\nFor: ${option.for}\n\nAgainst: ${option.against}\n`;
  });
  return [
    `# ${title}\n`,
    `${context}\n`,
    `The Builder chose ${decision.chosen}. ${decision.reason}\n`,
    "## Options offered\n",
    ...options,
    ...(consequence ? [`## Consequences\n\n${consequence}\n`] : []),
  ].join("\n");
}

/** The text of the Stack section, from its heading up to the next one; undefined without that heading. */
export function findStackSection(agents: string): { start: number; end: number; body: string } | undefined {
  const heading = /^## Stack[ \t]*$/m.exec(agents);
  if (!heading) return undefined;
  const start = heading.index + heading[0].length;
  const next = agents.slice(start).search(SECTION_HEADING);
  const end = next === -1 ? agents.length : start + next;
  return { start, end, body: agents.slice(start, end).trim() };
}

/** Whether AGENTS.md holds a Kickoff's decisions yet: its Stack section says so until then. */
export function kickoffRecorded(agents: string): boolean {
  const section = findStackSection(agents);
  return section !== undefined && !section.body.startsWith("Not decided yet");
}

export function withStackSection(agents: string, body: string): string {
  const section = findStackSection(agents);
  if (!section) return `${agents.trimEnd()}\n\n## Stack\n\n${body}\n`;
  const after = agents.slice(section.end);
  return `${agents.slice(0, section.start)}\n\n${body}\n${after === "" ? "" : `\n${after}`}`;
}

/** Commits only these files, so whatever the Builder has staged stays theirs. A no-op when they did not change. */
export async function commitRecord(siteDir: string, paths: string[], message: string): Promise<void> {
  if ((await git(siteDir, "status", "--porcelain", "--", ...paths)) === "") return;
  await git(siteDir, "add", "--", ...paths);
  const identity = await git(siteDir, "config", "user.email").then(
    () => [],
    () => ["-c", "user.name=web-factory", "-c", "user.email=web-factory@users.noreply.github.com"],
  );
  await git(siteDir, ...identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", ...paths);
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "decision";
}

/** Opens the context of an ADR a Request raised; the word after the number ends it, so #1 never reads as #12. */
function raisedBy(request: number): string {
  return `Raised by Request #${request}:`;
}

export function requestContext(request: number, words: string): string {
  return `${raisedBy(request)} ${words}`;
}

/**
 * Where the ADR this Request raises under this title lives: the file an earlier run of the same
 * Request wrote, or the next free number. Any other ADR of that title is another decision's record.
 */
export async function adrPath(siteDir: string, title: string, request: number): Promise<string> {
  const files = await readdir(join(siteDir, ADR_FOLDER)).catch(() => [] as string[]);
  const name = slug(title);
  for (const file of files.filter((candidate) => candidate.replace(/^\d+-/, "") === `${name}.md`)) {
    const [, context] = (await readFile(join(siteDir, ADR_FOLDER, file), "utf8")).split("\n\n");
    if (context?.startsWith(raisedBy(request))) return `${ADR_FOLDER}/${file}`;
  }
  const highest = Math.max(0, ...files.map((file) => Number(/^(\d+)-/.exec(file)?.[1] ?? 0)));
  return `${ADR_FOLDER}/${String(highest + 1).padStart(4, "0")}-${name}.md`;
}

export async function writeAdr(siteDir: string, path: string, content: string): Promise<void> {
  await mkdir(join(siteDir, ADR_FOLDER), { recursive: true });
  await writeFile(join(siteDir, path), content);
}

import { DtcgEmitterHandler, lint, type DesignSystemState, type LintReport, type ResolvedColor } from "@google/design.md/linter";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { git } from "./git.ts";
import type { Failure } from "./review/check.ts";

/**
 * The DESIGN.md format version this Factory reads. The format is alpha, so a Site stays on this
 * version until `factory update` moves it on purpose, together with the exact version of the
 * @google/design.md package in this package's dependencies.
 */
export const DESIGN_FORMAT_VERSION = "alpha";

/** The one committed folder the Design Stage leaves, relative to the Site's root. */
export const HANDOFF_FOLDER = "design";
export const DESIGN_FILE = `${HANDOFF_FOLDER}/DESIGN.md`;
export const TOKENS_FILE = `${HANDOFF_FOLDER}/tokens.json`;
export const PROVENANCE_FILE = `${HANDOFF_FOLDER}/source.json`;
export const SCREENSHOT_FOLDER = `${HANDOFF_FOLDER}/screenshots`;
/** A design tool's own code, kept to read and never built from. */
export const REFERENCE_FOLDER = `${HANDOFF_FOLDER}/reference`;
/** The images and fonts a design tool's design uses; unlike its code, these may go into the Site. */
export const ASSETS_FOLDER = `${HANDOFF_FOLDER}/assets`;

/** Where a design came from and how it was made. */
export interface Provenance {
  /** The design tool, or "none" when the model wrote the design. */
  tool: string;
  how: string;
  /** Where an imported design was fetched from, such as its project address; a design from no tool has none. */
  source?: string;
  /** The Spec this handoff was made for and is approved with. */
  spec: number;
  designFormat: string;
  /** The day the handoff was made, as YYYY-MM-DD. */
  date: string;
  /** Every route with a reference screenshot, e.g. "/" or "/menu.html". */
  routes: string[];
}

/**
 * The reference screenshot of a route: `/` is home.png and `/menu.html` is menu.html.png. Every
 * route gets a file of its own, also on a disk that ignores case: anything but lowercase letters,
 * digits, dots and hyphens is written as its code between underscores, so `/a/b.html` is
 * a_2f_b.html.png, and `/home` is _home.png because home.png belongs to `/`.
 */
export function screenshotFile(route: string): string {
  const escaped = route.slice(1).replace(/[^a-z0-9.-]/gu, (char) => `_${char.codePointAt(0)!.toString(16)}_`);
  const name = route === "/" ? "home" : route === "/home" ? "_home" : escaped;
  return `${SCREENSHOT_FOLDER}/${name}.png`;
}

/** The format version a DESIGN.md's front matter names; the linter does not report it. */
function formatVersion(design: string): string | undefined {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(design)?.[1] ?? "";
  return /^version:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m.exec(frontMatter)?.[1];
}

function readable(report: LintReport): Failure[] {
  const failures: Failure[] = [];
  for (const finding of report.findings) {
    const location = finding.path ? `${DESIGN_FILE} at ${finding.path}` : DESIGN_FILE;
    if (finding.rule === "contrast-ratio") {
      failures.push({ reason: `Text in this part of the design is too hard to read for many Visitors: ${finding.message} Pick colors further apart.`, location });
    } else if (finding.severity === "error" || finding.rule === undefined && finding.severity === "warning") {
      failures.push({ reason: `DESIGN.md does not pass its lint: ${finding.message}`, location });
    }
  }
  return failures;
}

function isColor(value: unknown): value is ResolvedColor {
  return typeof value === "object" && value !== null && "type" in value && value.type === "color";
}

function isSeeThrough(color: ResolvedColor): boolean {
  return (color.a ?? 1) < 1;
}

/** The contrast rule ignores a color's alpha, so it would measure see-through text as if it were solid. */
function seeThroughFailures({ components }: DesignSystemState): Failure[] {
  const failures: Failure[] = [];
  for (const [name, { properties }] of components) {
    for (const property of ["textColor", "backgroundColor"]) {
      const color = properties.get(property);
      if (isColor(color) && isSeeThrough(color)) {
        failures.push({ reason: `The ${property} ${color.hex} is see-through, so nobody can say how readable this text is: that depends on what lies behind it. Use a solid color here.`, location: `${DESIGN_FILE} at components.${name}` });
      }
    }
  }
  return failures;
}

/** The contrast rule only sees components with both colors, so a design with none would pass unmeasured. */
function hasContrastPair({ components }: DesignSystemState): boolean {
  const isSolid = (value: unknown) => isColor(value) && !isSeeThrough(value);
  return [...components.values()].some(({ properties }) => isSolid(properties.get("backgroundColor")) && isSolid(properties.get("textColor")));
}

/** What is wrong with a DESIGN.md's text: its format version, its lint and its contrast. */
export function lintDesign(design: string): Failure[] {
  const version = formatVersion(design);
  if (version !== DESIGN_FORMAT_VERSION) {
    const found = version === undefined ? "names no format version" : `is written in format version ${version}`;
    return [{ reason: `DESIGN.md ${found}, and this Factory is pinned to version ${DESIGN_FORMAT_VERSION}. Put \`version: ${DESIGN_FORMAT_VERSION}\` in its front matter; a newer format arrives through factory update.`, location: DESIGN_FILE }];
  }
  const report = lint(design);
  const failures = [...readable(report), ...seeThroughFailures(report.designSystem)];
  if (failures.length === 0 && !hasContrastPair(report.designSystem)) {
    failures.push({ reason: "DESIGN.md names no component with both a solid backgroundColor and a solid textColor, so its contrast cannot be checked and an unreadable palette would go unseen. Add at least the Site's main text and button as components.", location: DESIGN_FILE });
  }
  return failures;
}

/** The DTCG tokens a DESIGN.md generates. */
export function generateTokens(design: string): unknown {
  const result = new DtcgEmitterHandler().execute(lint(design).designSystem);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

export function serialiseTokens(tokens: unknown): string {
  return `${JSON.stringify(tokens, null, 2)}\n`;
}

/** The token paths that differ between two token files, such as `color.primary`. */
function differences(generated: unknown, found: unknown, path = ""): string[] {
  if (isDeepStrictEqual(generated, found)) return [];
  const isGroup = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !("$value" in value);
  if (!isGroup(generated) || !isGroup(found)) return [path];
  const keys = new Set([...Object.keys(generated), ...Object.keys(found)]);
  return [...keys].flatMap((key) => differences(generated[key], found[key], path ? `${path}.${key}` : key));
}

/** How to get generated files back in line, said wherever they are found out of line. */
const REGENERATE = "Never edit tokens.json by hand: DESIGN.md is the source. Change DESIGN.md if the change is wanted, then generate it again with factory design <spec>.";

function tokensFailures(design: string, raw: string | undefined): Failure[] {
  const location = TOKENS_FILE;
  if (raw === undefined) return [{ reason: `The Design handoff has no tokens.json, the design tokens the Site is built from. ${REGENERATE}`, location }];
  let found: unknown;
  try {
    found = JSON.parse(raw);
  } catch {
    return [{ reason: `tokens.json is not valid JSON. ${REGENERATE}`, location }];
  }
  const different = differences(generateTokens(design), found);
  if (different.length === 0) return [];
  return [{ reason: `tokens.json no longer matches DESIGN.md, so a Ticket could build from colors or sizes nobody approved. It differs at ${different.slice(0, 5).join(", ")}${different.length > 5 ? " and more" : ""}. ${REGENERATE}`, location }];
}

/** Reads and checks the handoff's provenance record; a record it cannot trust comes back as a failure. */
export async function readProvenance(siteDir: string): Promise<Provenance | Failure> {
  const location = PROVENANCE_FILE;
  let raw: string;
  try {
    raw = await readFile(join(siteDir, PROVENANCE_FILE), "utf8");
  } catch {
    return { reason: "The Design handoff has no source.json, the record of where this design came from. Make the handoff with factory design <spec>.", location };
  }
  let parsed: Partial<Provenance> | null;
  try {
    parsed = JSON.parse(raw) as Partial<Provenance> | null;
  } catch {
    return { reason: "source.json is not valid JSON. Make the handoff again with factory design <spec>.", location };
  }
  const routes = parsed?.routes;
  if (!parsed || typeof parsed.tool !== "string" || !Number.isInteger(parsed.spec) || !Array.isArray(routes) || routes.length === 0 || !routes.every((route) => typeof route === "string")) {
    return { reason: "source.json does not say which tool, Spec and routes this design comes from. Make the handoff again with factory design <spec>.", location };
  }
  if (parsed.tool !== "none" && typeof parsed.source !== "string") {
    return { reason: "source.json does not say where this imported design was fetched from. Import it again with factory design import.", location };
  }
  return parsed as Provenance;
}

async function screenshotFailures(siteDir: string, provenance: Provenance): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const route of provenance.routes) {
    const location = screenshotFile(route);
    const there = await access(join(siteDir, location)).then(() => true, () => false);
    if (!there) failures.push({ reason: `The Design handoff has no reference screenshot of ${route}, so nothing shows what was approved for that route. Make the handoff again with factory design <spec>.`, location });
  }
  return failures;
}

const CODE_FILE = /\.(html?|css|m?js|jsx|ts|tsx|vue|svelte|astro)$/iu;
/** Figma's code is kept as text, so that no Site's compiler picks it up. */
const REFERENCE_CODE_FILE = /\.(txt|html?|css|m?js|jsx|ts|tsx|vue|svelte|astro)$/iu;

/** Text that differs only in line endings or surrounding blank space is the same code. */
const sameCode = (text: string) => text.replace(/\r\n/gu, "\n").trim();

async function filesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/**
 * The tool's code is reference only, so the Site's own files must not be copies of it. This finds
 * a file copied whole, and cannot see one reworked after copying. Outside git there is no telling
 * which files are the Site's, so nothing is compared.
 */
async function copiedToolCode(siteDir: string): Promise<Failure[]> {
  const reference = new Map<string, string>();
  for (const file of await filesIn(join(siteDir, REFERENCE_FOLDER))) {
    if (!REFERENCE_CODE_FILE.test(file)) continue;
    const code = sameCode(await readFile(file, "utf8"));
    if (code !== "") reference.set(code, relative(siteDir, file));
  }
  if (reference.size === 0) return [];
  const listed = await git(siteDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard").catch(() => "");
  const failures: Failure[] = [];
  for (const file of listed.split("\0")) {
    if (!CODE_FILE.test(file) || file.startsWith(`${HANDOFF_FOLDER}/`)) continue;
    const code = await readFile(join(siteDir, file), "utf8").catch(() => undefined);
    const copied = code === undefined ? undefined : reference.get(sameCode(code));
    if (copied) failures.push({ reason: `This file is a copy of ${copied}, code a design tool generated. It is reference only, because the Site is built in the stack the Builder chose: build this page from DESIGN.md instead.`, location: file });
  }
  return failures;
}

/** Everything wrong with a Site's Design handoff, in plain words: an empty list means it stands. */
export async function handoffFailures(siteDir: string): Promise<Failure[]> {
  let design: string;
  try {
    design = await readFile(join(siteDir, DESIGN_FILE), "utf8");
  } catch {
    return [{ reason: "The Design handoff has no DESIGN.md, the one source of the Site's design. Restore it, or make it again in the Design Stage.", location: DESIGN_FILE }];
  }
  const lintFailures = lintDesign(design);
  const tokens = await readFile(join(siteDir, TOKENS_FILE), "utf8").catch(() => undefined);
  // A DESIGN.md of another format version cannot be read, so its tokens cannot be compared.
  const pinned = formatVersion(design) === DESIGN_FORMAT_VERSION;
  const failures = [...lintFailures, ...(pinned ? tokensFailures(design, tokens) : []), ...(await copiedToolCode(siteDir))];
  const provenance = await readProvenance(siteDir);
  if ("reason" in provenance) return [...failures, provenance];
  return [...failures, ...(await screenshotFailures(siteDir, provenance))];
}

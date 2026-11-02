import { DtcgEmitterHandler, lint, type DesignSystemState, type LintReport } from "@google/design.md/linter";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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

/** Where a design came from and how it was made. */
export interface Provenance {
  /** The design tool, or "none" when the model wrote the design. */
  tool: string;
  how: string;
  /** The Spec this handoff was made for and is approved with. */
  spec: number;
  designFormat: string;
  /** The day the handoff was made, as YYYY-MM-DD. */
  date: string;
  /** Every route with a reference screenshot, e.g. "/" or "/menu.html". */
  routes: string[];
}

/** The reference screenshot of a route: `/` is home.png and `/menu.html` is menu.html.png. */
export function screenshotFile(route: string): string {
  const name = route === "/" ? "home" : route.slice(1).replace(/[^a-zA-Z0-9.-]+/g, "-");
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

/** The contrast rule only sees components with both colors, so a design with none would pass unmeasured. */
function hasContrastPair({ components }: DesignSystemState): boolean {
  const isColor = (value: unknown) => typeof value === "object" && value !== null && "type" in value && value.type === "color";
  return [...components.values()].some(({ properties }) => isColor(properties.get("backgroundColor")) && isColor(properties.get("textColor")));
}

/** What is wrong with a DESIGN.md's text: its format version, its lint and its contrast. */
export function lintDesign(design: string): Failure[] {
  const version = formatVersion(design);
  if (version !== DESIGN_FORMAT_VERSION) {
    const found = version === undefined ? "names no format version" : `is written in format version ${version}`;
    return [{ reason: `DESIGN.md ${found}, and this Factory is pinned to version ${DESIGN_FORMAT_VERSION}. Put \`version: ${DESIGN_FORMAT_VERSION}\` in its front matter; a newer format arrives through factory update.`, location: DESIGN_FILE }];
  }
  const report = lint(design);
  const failures = readable(report);
  if (failures.length === 0 && !hasContrastPair(report.designSystem)) {
    failures.push({ reason: "DESIGN.md names no component with both a backgroundColor and a textColor, so its contrast cannot be checked and an unreadable palette would go unseen. Add at least the Site's main text and button as components.", location: DESIGN_FILE });
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
  const failures = [...lintFailures, ...(pinned ? tokensFailures(design, tokens) : [])];
  const provenance = await readProvenance(siteDir);
  if ("reason" in provenance) return [...failures, provenance];
  return [...failures, ...(await screenshotFailures(siteDir, provenance))];
}

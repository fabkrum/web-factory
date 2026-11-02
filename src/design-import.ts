import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Clock } from "./clock.ts";
import { readAgentCliChoice } from "./config.ts";
import { assertAwaitingHandoff, finishHandoff, readPassingDesign, refuse, SAMPLE_FOLDER, takeScreenshots } from "./design.ts";
import { ASSETS_FOLDER, REFERENCE_FOLDER, SCREENSHOT_FOLDER, screenshotFile } from "./design-handoff.ts";
import type { Tracker } from "./tracker.ts";

export const IMPORT_TOOLS = ["stitch", "figma", "claude-design"] as const;
export type ImportTool = (typeof IMPORT_TOOLS)[number];

/** Where an import skill saves what the tool answered. Sites ignore .factory, so none of it is committed. */
const exportFolder = (tool: ImportTool) => `.factory/design-import/${tool}`;

/** One page of a tool's design, with the picture of it the tool gave. */
interface Screen {
  title: string;
  /** The file names in the export, without their extension. */
  id: string;
}

/** What a computer leaves in a folder by itself, such as .DS_Store, and macOS puts in a zip. */
const isNoise = (name: string) => name.startsWith(".") || name === "__MACOSX";

const isThere = (path: string) => stat(path).then(() => true, () => false);

async function isEmptyFolder(folder: string): Promise<boolean> {
  return readdir(folder).then((names) => names.every(isNoise), () => true);
}

/** Screen ids come from a tool's answer and name files, so they stay plain names inside the export. */
function checkedId(id: string, title: string): string {
  if (!/^[\w-]+$/u.test(id)) throw refuse(`The screen "${title}" has the id "${id}", which cannot be read as a screen of this design. Fetch the design again.`);
  return id;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw refuse(`${file} could not be read as the tool's answer. Fetch the design again.`);
  }
}

/** Stitch's list_screens answer, saved as screens.json, with <id>.png and <id>.html beside it. */
async function stitchScreens(folder: string): Promise<Screen[]> {
  const answer = (await readJson(join(folder, "screens.json"))) as { screens?: unknown } | null;
  if (!Array.isArray(answer?.screens)) throw refuse(`${folder}/screens.json has no screens in it. Fetch the design again.`);
  return (answer.screens as { name?: unknown; title?: unknown }[]).map(({ name, title }) => {
    const label = typeof title === "string" ? title : "without a title";
    return { title: label, id: checkedId(typeof name === "string" ? (name.split("/").at(-1) ?? "") : "", label) };
  });
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
}

/** Figma's get_metadata answer, saved as metadata.xml, with <id>.png and <id>.txt beside it (its code as text, so no Site compiles it). Its outermost frames are the pages. */
async function figmaScreens(folder: string): Promise<Screen[]> {
  const xml = await readFile(join(folder, "metadata.xml"), "utf8").catch(() => {
    throw refuse(`${folder}/metadata.xml could not be read as the tool's answer. Fetch the design again.`);
  });
  const frames: (Screen & { depth: number })[] = [];
  let depth = 0;
  for (const [, closing, tag, attributes, selfClosing] of xml.matchAll(/<(\/?)([\w-]+)([^>]*?)(\/?)>/gu)) {
    if (closing) {
      depth--;
      continue;
    }
    if (tag === "frame") {
      const title = unescapeXml(/\bname="([^"]*)"/u.exec(attributes!)?.[1] ?? "without a title");
      // Figma writes ids as 1:2 and a file name cannot hold that everywhere.
      frames.push({ title, id: checkedId((/\bid="([^"]*)"/u.exec(attributes!)?.[1] ?? "").replace(":", "-"), title), depth });
    }
    if (!selfClosing) depth++;
  }
  const top = Math.min(...frames.map((frame) => frame.depth));
  return frames.filter((frame) => frame.depth === top);
}

/** A route per screen: the one that reads as the home page is /, or else the first, and the others are named after their titles. */
function routesOf(screens: Screen[]): string[] {
  const home = Math.max(screens.findIndex(({ title }) => /^(home|landing|index|start)\b/iu.test(title)), 0);
  const taken = new Set(["home"]);
  return screens.map(({ title }, index) => {
    if (index === home) return "/";
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "screen";
    let name = slug;
    for (let count = 2; taken.has(name); count++) name = `${slug}-${count}`;
    taken.add(name);
    return `/${name}`;
  });
}

async function isPng(file: string): Promise<boolean> {
  const bytes = await readFile(file);
  return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

async function checkPictures(folder: string, screens: Screen[]): Promise<void> {
  if (screens.length === 0) throw refuse(`${folder} holds no screens, so there is no design to bring in. Fetch the design again.`);
  for (const { title, id } of screens) {
    const picture = `${folder}/${id}.png`;
    if (!(await isThere(picture))) throw refuse(`The export has no picture of the screen ${title}: ${picture} is missing, and every route needs a reference screenshot. Fetch it again, or save the picture there.`);
    if (!(await isPng(picture))) throw refuse(`${picture} is not a PNG picture. Fetch it again, or save the picture there.`);
  }
}

/** Empties what the handoff holds from an earlier design, so nothing of an older import or sample stays. */
async function clearEarlierDesign(siteDir: string): Promise<void> {
  for (const folder of [SCREENSHOT_FOLDER, REFERENCE_FOLDER, ASSETS_FOLDER, SAMPLE_FOLDER]) await rm(join(siteDir, folder), { recursive: true, force: true });
}

/** Copies a tool's folder, leaving out what is not design: an archive, and links, which could point anywhere on the machine. */
async function copyDesignFiles(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: async (file) => !(await lstat(file)).isSymbolicLink() && extname(file) !== ".zip",
  });
}

/** Stitch and Figma give the pictures and code: the handoff takes them as they are. */
async function importScreens(siteDir: string, folder: string, screens: Screen[], codeExtension: string): Promise<string[]> {
  await checkPictures(folder, screens);
  const routes = routesOf(screens);
  await clearEarlierDesign(siteDir);
  await mkdir(join(siteDir, SCREENSHOT_FOLDER), { recursive: true });
  await mkdir(join(siteDir, REFERENCE_FOLDER), { recursive: true });
  for (const [index, { id }] of screens.entries()) {
    const route = routes[index]!;
    await cp(join(folder, `${id}.png`), join(siteDir, screenshotFile(route)));
    const code = join(folder, `${id}${codeExtension}`);
    if (await isThere(code)) await cp(code, join(siteDir, REFERENCE_FOLDER, `${route.slice(1) || "home"}${codeExtension}`));
  }
  if ((await readdir(join(siteDir, REFERENCE_FOLDER))).length === 0) await rm(join(siteDir, REFERENCE_FOLDER), { recursive: true });
  if (await isThere(join(folder, "assets"))) await copyDesignFiles(join(folder, "assets"), join(siteDir, ASSETS_FOLDER));
  return routes;
}

/** Why Claude Design has nothing to read yet, and the way forward for this Site's Agent CLI. */
async function noClaudeDesignExport(siteDir: string, folder: string): Promise<never> {
  const agentCli = await readAgentCliChoice(siteDir);
  if (agentCli === "claude-code") {
    throw refuse(`Nothing from Claude Design is in ${exportFolder("claude-design")} yet. In Claude Design choose Export, then Send to Claude Code, and follow the import-claude-design skill: it fetches the design into that folder.`);
  }
  await mkdir(folder, { recursive: true });
  throw refuse(
    `Claude Design hands a design over by itself only to Claude Code, and this Site uses ${agentCli}, so this takes one step by hand. In Claude Design, open your design, choose Export and download it as a .zip file. Put that file, as it is, into the folder ${exportFolder("claude-design")} of this Site. The folder now exists; it is hidden from git, so the download itself is never committed. You should see the .zip file in that folder. Then run this same command again.`,
  );
}

/** Unpacks a downloaded bundle into its folder, and finds the folder of pages inside. */
async function claudeDesignPages(folder: string): Promise<string> {
  for (const zip of (await readdir(folder)).filter((name) => extname(name) === ".zip")) {
    await promisify(execFile)("unzip", ["-oq", `./${zip}`], { cwd: folder }).catch(() => {
      throw refuse(`${folder}/${zip} could not be unpacked. Download it from Claude Design again; if this keeps happening, install the unzip command.`);
    });
  }
  const entries = (await readdir(folder, { withFileTypes: true })).filter((entry) => extname(entry.name) !== ".zip" && !isNoise(entry.name));
  const [only] = entries;
  return entries.length === 1 && only!.isDirectory() ? join(folder, only!.name) : folder;
}

/** The page to start from: index.html, or else the only page no other page links to. */
async function startPage(pages: string, folder: string): Promise<string> {
  const names = (await readdir(pages)).filter((name) => /\.html?$/iu.test(name));
  if (names.includes("index.html")) return "index.html";
  const linked = await Promise.all(names.map((name) => readFile(join(pages, name), "utf8")));
  const unlinked = names.filter((name) => !linked.some((html, index) => names[index] !== name && html.includes(`"${name}"`)));
  if (unlinked.length === 1) return unlinked[0]!;
  throw refuse(`The Claude Design export in ${folder} has no index.html, so there is no telling which page comes first. Name the first page index.html, then run this again.`);
}

/** Claude Design gives pages, not pictures, so its pages go to reference and the pictures are taken from them. */
async function importClaudeDesign(siteDir: string, folder: string): Promise<{ routes: string[]; manual: boolean }> {
  const manual = (await readdir(folder)).some((name) => extname(name) === ".zip");
  const pages = await claudeDesignPages(folder);
  const start = await startPage(pages, folder);
  await clearEarlierDesign(siteDir);
  await copyDesignFiles(pages, join(siteDir, REFERENCE_FOLDER));
  return { routes: await takeScreenshots(siteDir, REFERENCE_FOLDER, start === "index.html" ? "" : start), manual };
}

const HOW: Record<Exclude<ImportTool, "claude-design">, string> = {
  stitch: "The design was fetched from Stitch and its DESIGN.md taken from there; the tool's HTML is kept in design/reference as reference only.",
  figma: "The design was fetched from Figma, and DESIGN.md written from its variables and styles; the tool's code is kept in design/reference as reference only.",
};

/**
 * Reduces what a design tool gave to the one Design handoff, the same folder whichever tool it was:
 * the DESIGN.md the import skill wrote, a screenshot per route, the tool's code as reference only,
 * its assets and the provenance record. The Spec stays in the Design Stage until the Builder approves.
 */
export async function runDesignImport(options: { siteDir: string; tool: ImportTool; spec: number; source?: string; tracker: Tracker; clock: Clock; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, tool, spec, source, tracker, clock, stdout } = options;
  await assertAwaitingHandoff(siteDir, spec, tracker);
  const folder = join(siteDir, exportFolder(tool));
  const shown = relative(siteDir, folder);

  if (tool === "claude-design") {
    if (await isEmptyFolder(folder)) await noClaudeDesignExport(siteDir, folder);
    const design = await readPassingDesign(siteDir);
    const { routes, manual } = await importClaudeDesign(siteDir, folder);
    const how = `The Claude Design export was ${manual ? "downloaded by hand" : "fetched by Claude Code"} and DESIGN.md written from it; its pages are kept in design/reference as reference only.`;
    await finishHandoff({ siteDir, design, provenance: { tool, how, source: source ?? (manual ? "a file downloaded from Claude Design" : "Claude Design"), spec, routes }, clock, stdout });
    return;
  }

  if (await isEmptyFolder(folder)) {
    throw refuse(`Nothing is in ${shown} yet, so there is no design to bring in. Follow the import-${tool} skill: it fetches the design into that folder.`);
  }
  const design = await readPassingDesign(siteDir);
  const screens = tool === "stitch" ? await stitchScreens(folder) : await figmaScreens(folder);
  const routes = await importScreens(siteDir, folder, screens, tool === "stitch" ? ".html" : ".txt");
  await finishHandoff({ siteDir, design, provenance: { tool, how: HOW[tool], source, spec, routes }, clock, stdout });
}

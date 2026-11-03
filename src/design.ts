import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Clock } from "./clock.ts";
import { readSiteConfig } from "./config.ts";
import { commitRecord } from "./decision-record.ts";
import { ASSETS_FOLDER, DESIGN_FILE, DESIGN_FORMAT_VERSION, generateTokens, handoffFailures, HANDOFF_FOLDER, lintDesign, PROVENANCE_FILE, readProvenance, REFERENCE_FOLDER, SCREENSHOT_FOLDER, screenshotFile, serialiseTokens, TOKENS_FILE, type Provenance } from "./design-handoff.ts";
import { git, gitSucceeds } from "./git.ts";
import { PipelineError } from "./request.ts";
import { goTo, launchBrowser, openReviewPage, PageError } from "./review/browser.ts";
import type { Failure } from "./review/check.ts";
import { findRoutes } from "./review/routes.ts";
import { stageLabel, type Stage } from "./stages.ts";
import type { Issue, Tracker } from "./tracker.ts";

/** The pages that show the design, served only here: they are reference and never part of the Site. */
export const SAMPLE_FOLDER = `${HANDOFF_FOLDER}/sample`;

/** The size of the window a reference screenshot is taken in. */
const VIEWPORT = { width: 1280, height: 800 };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const WHAT_APPROVAL_MEANS = "Approving says: this design is what the Site should look like. It binds every Ticket of this Spec, because the Ticket loop builds them unattended from this folder alone and nobody asks you about colors or layout again. Only your approval sends the Tickets to the Ticket loop.";

export const refuse = (message: string) => new PipelineError(message);

function inStage(issue: Issue, stage: Stage): boolean {
  return issue.labels.some((label) => label.toLowerCase() === stageLabel(stage));
}

export function listFailures(failures: Failure[]): string {
  return failures.map(({ reason, location }) => `- ${location}: ${reason}`).join("\n");
}

/** Tickets are built from the base branch, so a handoff anywhere else would never reach them. */
export async function onBaseBranch(siteDir: string): Promise<void> {
  const { baseBranch } = await readSiteConfig(siteDir);
  const branch = await git(siteDir, "branch", "--show-current");
  if (branch.trim() !== baseBranch) {
    throw refuse(`The Design handoff belongs on ${baseBranch}, where the Ticket loop starts every Ticket, and this folder is on ${branch.trim() || "no branch"}. Switch to ${baseBranch}, then run this again.`);
  }
}

function serveFolder(root: string): Promise<Server> {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://sample").pathname));
    const file = path.endsWith("/") ? `${path}index.html` : path;
    try {
      const body = await readFile(join(root, file));
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Opens every route of a folder of pages in a real browser and keeps a picture of it. Returns the routes. */
export async function takeScreenshots(siteDir: string, folder: string, startPage = ""): Promise<string[]> {
  const server = await serveFolder(join(siteDir, folder));
  const browser = await launchBrowser();
  try {
    const start = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${encodeURIComponent(startPage)}`);
    const { routes } = await findRoutes(browser, start);
    await rm(join(siteDir, SCREENSHOT_FOLDER), { recursive: true, force: true });
    await mkdir(join(siteDir, SCREENSHOT_FOLDER), { recursive: true });
    const page = await openReviewPage(browser);
    await page.setViewportSize(VIEWPORT);
    for (const route of routes) {
      if (route.problem) throw refuse(`The sample page ${route.path} could not be opened: ${route.problem}`);
      await goTo(page, route.address).catch((error: unknown) => {
        throw error instanceof PageError ? refuse(`The sample page ${route.path} could not be opened: ${error.message}`) : error;
      });
      await page.screenshot({ path: join(siteDir, screenshotFile(route.path)), fullPage: true });
    }
    return routes.map((route) => route.path);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Only a Spec in the Design Stage gets a handoff, and only on the base branch. */
export async function assertAwaitingHandoff(siteDir: string, spec: number, tracker: Tracker): Promise<void> {
  const issue = await tracker.getIssue(spec);
  if (issue.state === "closed" || !inStage(issue, "design")) {
    throw refuse(`#${spec} is not a Spec waiting in the Design Stage, so it gets no Design handoff now. Its cut has to be confirmed first, and an approved Design stays: to change it, file a new Request.`);
  }
  await onBaseBranch(siteDir);
}

/** The DESIGN.md a handoff is made from, once it passes; nothing has changed if this refuses. */
export async function readPassingDesign(siteDir: string): Promise<string> {
  let design: string;
  try {
    design = await readFile(join(siteDir, DESIGN_FILE), "utf8");
  } catch {
    throw refuse(`${DESIGN_FILE} could not be read. It is the file the design skill writes.`);
  }
  const failures = lintDesign(design);
  if (failures.length > 0) throw refuse(`DESIGN.md cannot become the Design handoff yet, and nothing was changed:\n${listFailures(failures)}`);
  return design;
}

/** What every handoff ends with, whichever tool made it: the tokens, the record, the commit and the question to the Builder. */
export async function finishHandoff(options: { siteDir: string; design: string; provenance: Pick<Provenance, "tool" | "how" | "source" | "spec" | "routes">; clock: Clock; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, design, clock, stdout } = options;
  const { tool, how, source, spec, routes } = options.provenance;
  await writeFile(join(siteDir, TOKENS_FILE), serialiseTokens(generateTokens(design)));
  const provenance: Provenance = { tool, how, ...(source === undefined ? {} : { source }), spec, designFormat: DESIGN_FORMAT_VERSION, date: clock.now().toISOString().slice(0, 10), routes };
  await writeFile(join(siteDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  await commitRecord(siteDir, [HANDOFF_FOLDER], `Make the Design handoff for Spec #${spec}`);

  const again = tool === "none" ? `factory design ${spec}` : `factory design import ${tool} ${spec}${source === undefined ? "" : " <where-it-came-from>"}`;
  stdout(`The Design handoff of Spec #${spec} is ready in ${HANDOFF_FOLDER}/ and committed. Run git push so that GitHub has it.\n`);
  stdout(`Reference screenshots: ${routes.map(screenshotFile).join(", ")}\n\n`);
  stdout(`${WHAT_APPROVAL_MEANS}\n\nOnce the Builder approves: factory design approve ${spec}\nTo change the design: change it, then run ${again} again.\n`);
}

/**
 * Makes the no-tool Design handoff from the DESIGN.md and sample pages the design skill wrote:
 * generated tokens, a reference screenshot per route and the provenance record, all committed.
 * Running it again replaces them, and the Spec stays in the Design Stage until the Builder approves.
 */
export async function runDesign(options: { siteDir: string; spec: number; tracker: Tracker; clock: Clock; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, spec, tracker, clock, stdout } = options;
  await assertAwaitingHandoff(siteDir, spec, tracker);
  const design = await readPassingDesign(siteDir);
  await readFile(join(siteDir, SAMPLE_FOLDER, "index.html")).catch(async () => {
    const earlier = await readProvenance(siteDir);
    if (!("reason" in earlier) && earlier.tool !== "none") {
      throw refuse(`This Design handoff came from ${earlier.tool}, so it has no sample page. To bring in a new version, run factory design import ${earlier.tool} ${spec} with what you fetched.`);
    }
    throw refuse(`${SAMPLE_FOLDER}/index.html could not be read. It is the sample page the design skill builds for the Builder to approve.`);
  });

  const routes = await takeScreenshots(siteDir, SAMPLE_FOLDER);
  // A design without a tool keeps nothing from an earlier import.
  for (const folder of [REFERENCE_FOLDER, ASSETS_FOLDER]) await rm(join(siteDir, folder), { recursive: true, force: true });
  await finishHandoff({ siteDir, design, provenance: { tool: "none", how: `The model wrote DESIGN.md and a sample page from Spec #${spec}; no design tool was used.`, spec, routes }, clock, stdout });
}

/** The Builder approved the Design handoff: only this moves the Spec's confirmed Tickets to the Build Stage. */
export async function approveDesign(options: { siteDir: string; spec: number; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, spec, tracker, stdout } = options;
  const issue = await tracker.getIssue(spec);
  if (inStage(issue, "build")) {
    stdout(`The Design of Spec #${spec} is already approved, so its Tickets are in the Build Stage. Start them with: factory loop ${spec}\n`);
    return;
  }
  if ((["review", "approve", "publish", "measure"] as const).some((stage) => inStage(issue, stage))) {
    stdout(`The Design of Spec #${spec} is already approved, and the Spec has moved on since. To see what to do now, run: factory next\n`);
    return;
  }
  if (issue.state === "closed" || !inStage(issue, "design")) {
    throw refuse(`#${spec} is not a Spec waiting in the Design Stage, so there is no Design to approve. If it is a Ticket, approve its Spec instead.`);
  }
  const tickets = (await tracker.ticketsOf(spec)).filter((ticket) => ticket.state === "open");
  if (tickets.length === 0) throw refuse(`#${spec} has no open Tickets, so there is nothing to send to the Ticket loop.`);

  await onBaseBranch(siteDir);
  const failures = await handoffFailures(siteDir);
  if (failures.length > 0) throw refuse(`This Design handoff does not stand, so it cannot be approved:\n${listFailures(failures)}`);
  const provenance = await readProvenance(siteDir);
  if ("reason" in provenance || provenance.spec !== spec) {
    throw refuse(`The handoff in ${HANDOFF_FOLDER}/ was not made for Spec #${spec}. Run factory design ${spec} first and show the Builder the result.`);
  }
  const uncommitted = await gitSucceeds(siteDir, "diff", "--quiet", "HEAD", "--", HANDOFF_FOLDER).then((same) => !same);
  const untracked = (await git(siteDir, "ls-files", "--others", "--exclude-standard", "--", HANDOFF_FOLDER)).trim() !== "";
  if (uncommitted || untracked) {
    throw refuse(`${HANDOFF_FOLDER}/ has changes that are not committed, so what the Tickets get is not what the Builder saw. Run factory design ${spec} and show the Builder the result.`);
  }

  // Tickets first, so a run GitHub cuts short leaves the Spec in Design, and running again finishes it.
  for (const ticket of tickets) await tracker.moveToStage(ticket.number, "build");
  await tracker.moveToStage(spec, "build");
  stdout(`The Design of Spec #${spec} is approved. Its ${tickets.length} Ticket${tickets.length === 1 ? " is" : "s are"} in the Build Stage. Start the Ticket loop with: factory loop ${spec}\n`);
}

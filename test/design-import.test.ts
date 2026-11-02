import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFixtureRepo, type FixtureRepo } from "./harness/fixture-repo.ts";
import { serveFixtureSite } from "./harness/fixture-site.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

const EXPORTS = join(import.meta.dirname, "fixtures", "design-imports");

const DESIGN = `---
version: alpha
name: A bakery
colors:
  primary: "#1A1C1E"
  surface: "#FFFFFF"
typography:
  body:
    fontFamily: Public Sans
    fontSize: 1rem
rounded:
  sm: 4px
spacing:
  md: 16px
components:
  page:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
---

## Overview

Warm and plain.
`;

const exportFolder = (site: string, tool: string) => join(site, ".factory/design-import", tool);

/** A Site whose Spec waits in the Design Stage, with the DESIGN.md an import skill wrote, as .gitignore keeps .factory out. */
function siteInDesign({ agentCli }: { agentCli?: string } = {}) {
  const site = createSiteRepo({ testCommand: "true" });
  commitFile(site, ".gitignore", ".factory/\n");
  if (agentCli) {
    const config = JSON.parse(readFileSync(`${site}/factory.json`, "utf8")) as Record<string, unknown>;
    commitFile(site, "factory.json", JSON.stringify({ ...config, agentCli }));
  }
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A bakery Site");
  const ticket = tracker.addTicket(spec, "Home page", "", ["stage:spec"]);
  void tracker.moveToStage(spec, "design");
  writeFile(site, "design/DESIGN.md", DESIGN);
  return { site, tracker, spec, ticket };
}

function saveExport(site: string, tool: "stitch" | "figma"): void {
  cpSync(join(EXPORTS, tool), exportFolder(site, tool), { recursive: true });
}

function saveClaudeDesignZip(site: string): void {
  mkdirSync(exportFolder(site, "claude-design"), { recursive: true });
  cpSync(join(EXPORTS, "claude-design.zip"), join(exportFolder(site, "claude-design"), "design.zip"));
}

/** The run that unpacks a download and stops, as it does before anything of a download is imported. */
async function unpackClaudeDesignZip(site: string, tracker: FakeTracker, spec: number): Promise<string> {
  const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });
  expect(run.stderr).toMatch(/nothing is imported yet/);
  return run.stderr;
}

const provenance = (site: string) => JSON.parse(readFileSync(`${site}/design/source.json`, "utf8")) as Record<string, unknown> & { routes: string[] };
const tracked = (site: string) => git(site, "ls-files", "design").split("\n");

/** Everything every import leaves, whichever tool made the design. */
function expectSameFolderShape(site: string, routes: string[]) {
  expect(tracked(site)).toEqual(expect.arrayContaining(["design/DESIGN.md", "design/tokens.json", "design/source.json"]));
  expect(provenance(site)).toMatchObject({ designFormat: "alpha", routes });
  expect(git(site, "status", "--porcelain")).toBe("");
}

describe("factory design import", () => {
  it("fills the Design handoff from a Stitch export and records where it came from", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "stitch");

    const run = await runFactory(["design", "import", "stitch", String(spec), "https://stitch.withgoogle.com/projects/4410"], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expectSameFolderShape(site, ["/menu", "/", "/menu-2"]);
    expect(provenance(site)).toMatchObject({ tool: "stitch", source: "https://stitch.withgoogle.com/projects/4410", spec });
    expect(tracked(site)).toEqual(expect.arrayContaining(["design/screenshots/home.png", "design/screenshots/menu.png", "design/screenshots/menu-2.png", "design/reference/home.html", "design/reference/menu.html", "design/assets/logo.png"]));
    expect(readFileSync(`${site}/design/screenshots/home.png`)).toEqual(readFileSync(join(EXPORTS, "stitch/a1b2.png")));
    expect(run.stdout).toMatch(/binds every Ticket/);
  });

  it("puts only a Stitch export's images, fonts and video in design/assets, never its code", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "stitch");

    const run = await runFactory(["design", "import", "stitch", String(spec), "project 4410"], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracked(site).filter((file) => file.startsWith("design/assets/"))).toEqual(["design/assets/logo.png"]);
  });

  it("keeps code and links out of a Figma export's assets, and leaves no folder when nothing else is there", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "figma");
    writeFile(exportFolder(site, "figma"), "assets/widget.js", "console.log('Figma');");
    symlinkSync("/etc/hosts", join(exportFolder(site, "figma"), "assets/hosts.png"));

    const run = await runFactory(["design", "import", "figma", String(spec), "project abc"], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(existsSync(`${site}/design/assets`)).toBe(false);
  });

  it("fills the same folder from a Figma export, one route per top-level frame", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "figma");

    const run = await runFactory(["design", "import", "figma", String(spec), "https://www.figma.com/design/abc/Bakery"], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expectSameFolderShape(site, ["/", "/prices-hours"]);
    expect(provenance(site)).toMatchObject({ tool: "figma", source: "https://www.figma.com/design/abc/Bakery", spec });
    expect(tracked(site)).toEqual(expect.arrayContaining(["design/screenshots/home.png", "design/screenshots/prices-hours.png", "design/reference/home.txt"]));
  });

  it("fills the same folder from a Claude Design zip, taking the pictures itself", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "codex" });
    saveClaudeDesignZip(site);
    await unpackClaudeDesignZip(site, tracker, spec);

    const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expectSameFolderShape(site, ["/Landing.html", "/About.html"]);
    expect(provenance(site)).toMatchObject({ tool: "claude-design", spec });
    expect(String(provenance(site).how)).toMatch(/downloaded by hand/);
    expect(tracked(site)).toEqual(expect.arrayContaining(["design/reference/Landing.html", "design/reference/style.css"]));
    expect(tracked(site).some((file) => file.endsWith(".zip"))).toBe(false);
    expect(tracked(site)).toEqual(expect.arrayContaining(["design/reference/images/logo.png", "design/assets/images/logo.png"]));
    expect(readFileSync(`${site}/design/assets/images/logo.png`)).toEqual(readFileSync(`${site}/design/reference/images/logo.png`));
    expect(tracked(site).filter((file) => file.startsWith("design/assets/"))).toEqual(["design/assets/images/logo.png"]);
    const pictures = provenance(site).routes.map((route) => readFileSync(`${site}/design/screenshots/${route === "/Landing.html" ? "_4c_anding.html" : "_41_bout.html"}.png`).toString("base64"));
    expect(new Set(pictures).size).toBe(2);
  });

  it("stops after unpacking a download, so the Builder decides on its assets before anything is imported", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "codex" });
    saveClaudeDesignZip(site);

    const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/images\/logo\.png/);
    expect(run.stderr).toMatch(/may use/);
    expect(existsSync(`${site}/design/assets`)).toBe(false);
    expect(existsSync(`${site}/design/source.json`)).toBe(false);
    expect(readdirSync(exportFolder(site, "claude-design")).some((name) => name.endsWith(".zip"))).toBe(false);
  });

  it("keeps a file the Builder may not use out of the handoff, also after a refused run", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "codex" });
    saveClaudeDesignZip(site);
    const unpacked = await unpackClaudeDesignZip(site, tracker, spec);
    const unpackedFolder = join(site, /unpacked in (\S+) and/u.exec(unpacked)![1]!);
    rmSync(join(unpackedFolder, "images/logo.png"));

    writeFile(site, "design/DESIGN.md", "Not a design yet");
    const refused = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });
    expect(refused.exitCode).toBe(1);
    writeFile(site, "design/DESIGN.md", DESIGN);
    const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracked(site).some((file) => file.endsWith("logo.png"))).toBe(false);
    expect(String(provenance(site).how)).toMatch(/downloaded by hand/);
  });

  it("takes a folder Claude Code put there itself, and says so", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "claude-code" });
    writeFile(exportFolder(site, "claude-design"), "index.html", `<!doctype html><html lang="en"><title>Home</title><h1>Home</h1></html>`);

    const run = await runFactory(["design", "import", "claude-design", String(spec), "https://claude.ai/design/p/1"], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expectSameFolderShape(site, ["/"]);
    expect(provenance(site)).toMatchObject({ source: "https://claude.ai/design/p/1" });
    expect(String(provenance(site).how)).toMatch(/Claude Code/);
    expect(existsSync(`${site}/design/assets`)).toBe(false);
  });

  it("puts only a Claude Design export's assets in design/assets, and no folder when it has none", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "claude-code" });
    const folder = exportFolder(site, "claude-design");
    writeFile(folder, "index.html", `<!doctype html><html lang="en"><title>Home</title><h1>Home</h1></html>`);
    writeFile(folder, "notes.md", "Notes from the tool");
    writeFile(folder, "fonts/Brand.WOFF2", "font");
    writeFile(folder, "__MACOSX/._logo.png", "what macOS adds");

    const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracked(site).filter((file) => file.startsWith("design/assets/"))).toEqual(["design/assets/fonts/Brand.WOFF2"]);
    expect(String(provenance(site).how)).toMatch(/design\/assets/);
  });

  it("gives Claude Design under another Agent CLI one explained manual step", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "gemini" });

    const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/one step by hand/);
    expect(run.stderr).toMatch(/\.factory\/design-import\/claude-design/);
    expect(run.stderr).toMatch(/You should see/);
    expect(existsSync(exportFolder(site, "claude-design"))).toBe(true);
    expect(existsSync(`${site}/design/source.json`)).toBe(false);
  });

  it("sends Claude Design under Claude Code to the automatic handoff, with no manual step", async () => {
    const { site, tracker, spec } = siteInDesign({ agentCli: "claude-code" });

    const run = await runFactory(["design", "import", "claude-design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).not.toMatch(/by hand/);
    expect(run.stderr).toMatch(/Send to Claude Code/);
  });

  it("keeps the tool's code out of the Site", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "stitch");
    const before = git(site, "ls-files").split("\n");

    await runFactory(["design", "import", "stitch", String(spec), "project 4410"], { cwd: site, tracker });

    const added = git(site, "ls-files").split("\n").filter((file) => !before.includes(file));
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((file) => !file.startsWith("design/"))).toEqual([]);
  });

  it("replaces what an earlier import left, also when the tool changes", async () => {
    const { site, tracker, spec } = siteInDesign();
    writeFile(site, "design/sample/index.html", "<!doctype html>");
    saveExport(site, "stitch");
    await runFactory(["design", "import", "stitch", String(spec), "project 4410"], { cwd: site, tracker });
    expect(existsSync(`${site}/design/sample`)).toBe(false);
    saveExport(site, "figma");

    const run = await runFactory(["design", "import", "figma", String(spec), "file abc"], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(readdirSync(`${site}/design/reference`)).toEqual(["home.txt"]);
    expect(readdirSync(`${site}/design/screenshots`).sort()).toEqual(["home.png", "prices-hours.png"]);
    expect(existsSync(`${site}/design/assets`)).toBe(false);
    expect(git(site, "status", "--porcelain")).toBe("");
  });

  it("drops the tool's code when the Builder goes back to no tool", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "stitch");
    await runFactory(["design", "import", "stitch", String(spec), "project 4410"], { cwd: site, tracker });

    const sent = await runFactory(["design", String(spec)], { cwd: site, tracker });
    expect(sent.exitCode).toBe(1);
    expect(sent.stderr).toMatch(/came from stitch.*factory design import stitch/);

    writeFile(site, "design/sample/index.html", `<!doctype html><html lang="en"><title>Bakery</title><h1>Bakery</h1></html>`);
    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(provenance(site).tool).toBe("none");
    expect(provenance(site).source).toBeUndefined();
    expect(existsSync(`${site}/design/reference`)).toBe(false);
    expect(git(site, "status", "--porcelain")).toBe("");
  });

  it("can be approved like any other handoff", async () => {
    const { site, tracker, spec, ticket } = siteInDesign();
    saveExport(site, "figma");
    await runFactory(["design", "import", "figma", String(spec), "file abc"], { cwd: site, tracker });

    const approved = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });

    expect(approved.exitCode, approved.stderr).toBe(0);
    expect(tracker.issue(ticket).labels).toEqual(["stage:build"]);
  });

  it.each([
    ["no DESIGN.md", (site: string) => rmSync(`${site}/design/DESIGN.md`), /DESIGN\.md could not be read/],
    ["a failing DESIGN.md", (site: string) => writeFile(site, "design/DESIGN.md", DESIGN.replace("#1A1C1E", "#EEEEEE")), /too hard to read/],
    ["a missing picture", (site: string) => rmSync(`${exportFolder(site, "stitch")}/c3d4.png`), /no picture of the screen Menu.*c3d4\.png/],
    ["a picture that is no PNG", (site: string) => writeFile(exportFolder(site, "stitch"), "a1b2.png", "{}"), /a1b2\.png is not a PNG/],
    ["an unreadable response", (site: string) => writeFile(exportFolder(site, "stitch"), "screens.json", "<html>"), /screens\.json/],
    ["a response with no screens", (site: string) => writeFile(exportFolder(site, "stitch"), "screens.json", `{"screens":[]}`), /no screens/],
  ])("refuses %s and changes nothing", async (_name, spoil, message) => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "stitch");
    writeFile(site, "design/reference/old.html", "kept");
    spoil(site);

    const run = await runFactory(["design", "import", "stitch", String(spec), "project 4410"], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(message);
    expect(readFileSync(`${site}/design/reference/old.html`, "utf8")).toBe("kept");
    expect(existsSync(`${site}/design/source.json`)).toBe(false);
  });

  it("refuses a screen id that would leave the export folder", async () => {
    const { site, tracker, spec } = siteInDesign();
    saveExport(site, "stitch");
    writeFile(exportFolder(site, "stitch"), "screens.json", JSON.stringify({ screens: [{ name: "..", title: "Home" }] }));

    const run = await runFactory(["design", "import", "stitch", String(spec), "project 4410"], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/cannot be read as a screen/);
  });

  it("says what is missing when nothing was fetched yet, or the Spec is elsewhere", async () => {
    const { site, tracker, spec } = siteInDesign();
    const empty = await runFactory(["design", "import", "figma", String(spec), "file abc"], { cwd: site, tracker });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toMatch(/\.factory\/design-import\/figma.*import-figma/s);

    await tracker.moveToStage(spec, "spec");
    const early = await runFactory(["design", "import", "figma", String(spec), "file abc"], { cwd: site, tracker });
    expect(early.exitCode).toBe(1);
    expect(early.stderr).toMatch(/not a Spec waiting in the Design Stage/);
  });

  it("explains the arguments it needs", async () => {
    const cwd = process.cwd();
    const tracker = new FakeTracker();
    expect((await runFactory(["design", "import", "penpot", "1", "x"], { cwd, tracker })).exitCode).toBe(2);
    expect((await runFactory(["design", "import", "stitch", "1"], { cwd, tracker })).exitCode).toBe(2);
    expect((await runFactory(["design", "import", "stitch"], { cwd, tracker })).exitCode).toBe(2);
  });
});

describe("the code/design Review check on tool code", () => {
  let repo: FixtureRepo | undefined;
  afterEach(async () => {
    await repo?.remove();
    repo = undefined;
  });

  async function failures(change: (dir: string) => void) {
    const served = await serveFixtureSite("clean");
    try {
      repo = await copyFixtureRepo("design-clean", "http://127.0.0.1:9/");
      const generated = "<main class='tw-generated'>made by a tool</main>\n";
      writeFile(repo.dir, "design/reference/home.html", generated);
      change(repo.dir);
      git(repo.dir, "init", "-q");
      const run = await runFactory(["review", served.url, "--json", "--check", "code/design"], { cwd: repo.dir });
      const report = JSON.parse(run.stdout) as { areas: { checks: { failures: { reason: string; location: string }[] }[] }[] };
      return report.areas.flatMap((area) => area.checks).flatMap((check) => check.failures);
    } finally {
      await served.close();
    }
  }

  it("fails a Site file that is a copy of the tool's code, and says which", async () => {
    const found = await failures((dir) => writeFile(dir, "src/home.html", "<main class='tw-generated'>made by a tool</main>\r\n"));
    expect(found).toHaveLength(1);
    expect(found[0]!.location).toBe("src/home.html");
    expect(found[0]!.reason).toMatch(/copy of design\/reference\/home\.html/);
  });

  it("fails a copy of Figma's code, which is kept as text", async () => {
    const found = await failures((dir) => {
      writeFile(dir, "design/reference/hero.txt", "export const Hero = () => null;\n");
      writeFile(dir, "src/Hero.tsx", "export const Hero = () => null;\n");
    });
    expect(found.map((failure) => failure.location)).toEqual(["src/Hero.tsx"]);
  });

  it("passes a Site that built its own page, and ignores what git ignores", async () => {
    const found = await failures((dir) => {
      writeFile(dir, "src/home.html", "<main>written for this Site</main>\n");
      writeFile(dir, ".gitignore", "dist/\n");
      writeFile(dir, "dist/home.html", "<main class='tw-generated'>made by a tool</main>\n");
    });
    expect(found).toEqual([]);
  });

  it("does not mistake a picture for code, so assets may be used", async () => {
    const found = await failures((dir) => {
      mkdirSync(dirname(`${dir}/public/logo.svg`), { recursive: true });
      writeFileSync(`${dir}/design/reference/logo.svg`, "<svg/>");
      writeFileSync(`${dir}/public/logo.svg`, "<svg/>");
    });
    expect(found).toEqual([]);
  });
});

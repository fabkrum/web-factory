import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lintDesign, screenshotFile } from "../src/design-handoff.ts";
import { copyFixtureRepo, type FixtureRepo } from "./harness/fixture-repo.ts";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

const DESIGN = (text = "#1A1C1E", version = "version: alpha") => `---
${version}
name: A bakery
colors:
  primary: "${text}"
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

const SAMPLE = `<!doctype html><html lang="en"><title>Bakery</title><h1>Bakery</h1><a href="/menu.html">Menu</a></html>`;
const MENU = `<!doctype html><html lang="en"><title>Menu</title><h1>Menu</h1></html>`;

/** A Site with a Spec whose confirmed cut waits in the Design Stage, and what the design skill wrote. */
function siteInDesign({ design = DESIGN() } = {}) {
  const site = createSiteRepo({ testCommand: "true" });
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A bakery Site");
  const ticket = tracker.addTicket(spec, "Home page", "", ["stage:spec"]);
  void tracker.moveToStage(spec, "design");
  writeFile(site, "design/DESIGN.md", design);
  writeFile(site, "design/sample/index.html", SAMPLE);
  writeFile(site, "design/sample/menu.html", MENU);
  return { site, tracker, spec, ticket };
}

function labels(tracker: FakeTracker, issue: number): string[] {
  return tracker.issue(issue).labels;
}

function committed(site: string): string[] {
  return git(site, "ls-files", "design").split("\n");
}

describe("factory design, the no-tool path", () => {
  it("leaves DESIGN.md, generated tokens, a reference screenshot per route and a provenance record, committed", async () => {
    const { site, tracker, spec, ticket } = siteInDesign();

    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(committed(site)).toEqual(
      expect.arrayContaining(["design/DESIGN.md", "design/tokens.json", "design/source.json", "design/screenshots/home.png", "design/screenshots/menu.html.png", "design/sample/index.html"]),
    );
    expect(git(site, "status", "--porcelain")).toBe("");

    const tokens = JSON.parse(readFileSync(`${site}/design/tokens.json`, "utf8")) as { $schema: string; color: { primary: { $value: { hex: string } } } };
    expect(tokens.$schema).toContain("2025.10");
    expect(tokens.color.primary.$value.hex).toBe("#1a1c1e");

    const png = readFileSync(`${site}/design/screenshots/home.png`);
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    const provenance = JSON.parse(readFileSync(`${site}/design/source.json`, "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({ tool: "none", spec, designFormat: "alpha", routes: ["/", "/menu.html"] });

    expect(run.stdout).toMatch(/binds every Ticket/);
    expect(labels(tracker, spec)).toEqual(["stage:design"]);
    expect(labels(tracker, ticket)).toEqual(["stage:spec"]);
  });

  it("refuses a DESIGN.md with failing contrast and changes nothing", async () => {
    const { site, tracker, spec } = siteInDesign({ design: DESIGN("#EEEEEE") });

    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/too hard to read.*1\.\d+:1/);
    expect(existsSync(`${site}/design/tokens.json`)).toBe(false);
    expect(git(site, "ls-files", "design")).toBe("");
  });

  it("refuses see-through text or background in every way of writing a color, and changes nothing", async () => {
    for (const color of ["#00000010", "#1A1C1E00", "#0008", "rgba(0, 0, 0, 0.5)", "rgb(0 0 0 / 50%)", "hsl(0 0% 0% / 0.2)", "oklch(0.2 0 0 / 0.5)", "transparent"]) {
      expect(lintDesign(DESIGN(color)).map((failure) => failure.location), color).toEqual(["design/DESIGN.md at components.page"]);
      const background = DESIGN().replace('surface: "#FFFFFF"', `surface: "${color}"`);
      expect(lintDesign(background).map((failure) => failure.reason), color).toContainEqual(expect.stringMatching(/backgroundColor .* is see-through/));
    }
    expect(lintDesign(DESIGN("#000000FF"))).toEqual([]);

    const { site, tracker, spec } = siteInDesign({ design: DESIGN("#00000010") });
    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/textColor #00000010 is see-through/);
    expect(existsSync(`${site}/design/tokens.json`)).toBe(false);
  });

  it("does not count a see-through pair as a measured one, whatever else the component holds", () => {
    const failures = lintDesign(DESIGN().replace('primary: "#1A1C1E"', 'primary: "#1A1C1E00"'));
    expect(failures.map((failure) => failure.reason)).toEqual([expect.stringMatching(/see-through/)]);
  });

  it("gives every route a screenshot of its own, also where routes differ only in punctuation or case", () => {
    const routes = ["/", "/home", "/_home", "/a/b.html", "/a-b.html", "/a+b.html", "/a b.html", "/a_b.html", "/a_2f_b.html", "/Menu.html", "/menu.html", "/a%2Fb.html", "/a%2fb.html"];
    const files = routes.map((route) => screenshotFile(route).toLowerCase());
    expect(new Set(files).size).toBe(routes.length);
    expect(screenshotFile("/")).toBe("design/screenshots/home.png");
    expect(screenshotFile("/menu.html")).toBe("design/screenshots/menu.html.png");
  });

  it("commits one screenshot per route when the sample's routes would once have shared a file", async () => {
    const { site, tracker, spec } = siteInDesign();
    const page = (title: string) => `<!doctype html><html lang="en"><title>${title}</title><h1>${title}</h1></html>`;
    writeFile(site, "design/sample/index.html", `<!doctype html><html lang="en"><title>Bakery</title><h1>Bakery</h1><a href="/home/">Home</a><a href="/a/b.html">One</a><a href="/a-b.html">Two</a></html>`);
    writeFile(site, "design/sample/home/index.html", page("Another home, which is long enough to look different"));
    writeFile(site, "design/sample/a/b.html", page("One"));
    writeFile(site, "design/sample/a-b.html", page("Two, with quite a different and longer title"));

    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });
    expect(run.exitCode, run.stderr).toBe(0);

    const { routes } = JSON.parse(readFileSync(`${site}/design/source.json`, "utf8")) as { routes: string[] };
    expect([...routes].sort()).toEqual(["/", "/a-b.html", "/a/b.html", "/home"]);
    const files = routes.map(screenshotFile);
    expect(committed(site)).toEqual(expect.arrayContaining(files));
    const pictures = files.map((file) => readFileSync(`${site}/${file}`).toString("base64"));
    expect(new Set(pictures).size).toBe(routes.length);
  });

  it("refuses a DESIGN.md with no text and background pair, whose contrast nothing could measure", async () => {
    const { site, tracker, spec } = siteInDesign({ design: DESIGN().replace(/components:[\s\S]*?---/, "---") });

    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/contrast cannot be checked/);
  });

  it("refuses a DESIGN.md in any other format version than the pinned one", async () => {
    for (const version of ["version: beta", "name-only: true"]) {
      const { site, tracker, spec } = siteInDesign({ design: DESIGN(undefined, version) });
      const run = await runFactory(["design", String(spec)], { cwd: site, tracker });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toMatch(/pinned to version alpha/);
    }
  });

  it("pins the DESIGN.md package at one exact version", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@google/design.md"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("refuses a Spec that is not in the Design Stage", async () => {
    const { site, tracker, spec } = siteInDesign();
    await tracker.moveToStage(spec, "spec");

    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/not a Spec waiting in the Design Stage/);
    expect(git(site, "ls-files", "design")).toBe("");
  });

  it("refuses to make the handoff away from the base branch, where no Ticket would get it", async () => {
    const { site, tracker, spec } = siteInDesign();
    git(site, "switch", "-q", "-c", "elsewhere");

    const run = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/belongs on main/);
  });
});

describe("factory design approve", () => {
  it("is the only way a Spec's Tickets reach the Build Stage and the Ticket loop", async () => {
    const { site, tracker, spec, ticket } = siteInDesign();
    let sessions = 0;
    const agentCli = new FakeAgentCli((session) => {
      sessions++;
      commitFile(session.cwd, "index.html", "<h1>Home</h1>\n");
    });
    await runFactory(["design", String(spec)], { cwd: site, tracker });

    const before = await runFactory(["loop", String(spec)], { cwd: site, tracker, agentCli });
    expect(before.exitCode).toBe(0);
    expect(sessions).toBe(0);

    const approved = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });
    expect(approved.exitCode, approved.stderr).toBe(0);
    expect(labels(tracker, ticket)).toEqual(["stage:build"]);
    expect(labels(tracker, spec)).toEqual(["stage:build"]);

    const after = await runFactory(["loop", String(spec)], { cwd: site, tracker, agentCli });
    expect(after.exitCode, after.stderr + after.stdout).toBe(0);
    expect(sessions).toBe(1);
    expect(tracker.issue(ticket).state).toBe("closed");

    const twice = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });
    expect(twice.exitCode).toBe(0);
    expect(twice.stdout).toMatch(/already approved/);
  });

  it("keeps the Spec in the Design Stage when the Builder asks for changes", async () => {
    const { site, tracker, spec, ticket } = siteInDesign();
    await runFactory(["design", String(spec)], { cwd: site, tracker });

    writeFile(site, "design/DESIGN.md", DESIGN("#222222"));
    const again = await runFactory(["design", String(spec)], { cwd: site, tracker });

    expect(again.exitCode, again.stderr).toBe(0);
    expect(labels(tracker, spec)).toEqual(["stage:design"]);
    expect(labels(tracker, ticket)).toEqual(["stage:spec"]);
    expect(readFileSync(`${site}/design/tokens.json`, "utf8")).toContain("#222222");
    expect(git(site, "status", "--porcelain")).toBe("");
  });

  it("refuses when there is no handoff yet, or the Spec is not in the Design Stage", async () => {
    const { site, tracker, spec, ticket } = siteInDesign();

    const none = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });
    expect(none.exitCode).toBe(1);
    expect(labels(tracker, ticket)).toEqual(["stage:spec"]);

    await tracker.moveToStage(spec, "spec");
    const early = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });
    expect(early.exitCode).toBe(1);
    expect(early.stderr).toMatch(/no Design to approve/);
    expect(labels(tracker, ticket)).toEqual(["stage:spec"]);
  });

  it("refuses hand-edited tokens, uncommitted changes and another Spec's handoff, and moves nothing", async () => {
    const { site, tracker, spec, ticket } = siteInDesign();
    await runFactory(["design", String(spec)], { cwd: site, tracker });
    const tokens = readFileSync(`${site}/design/tokens.json`, "utf8");

    writeFileSync(`${site}/design/tokens.json`, tokens.replace("#1a1c1e", "#ff0000"));
    const edited = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toMatch(/no longer matches DESIGN\.md.*color\.primary/);

    writeFileSync(`${site}/design/tokens.json`, tokens);
    writeFile(site, "design/sample/index.html", `${SAMPLE}<!-- changed -->`);
    const dirty = await runFactory(["design", "approve", String(spec)], { cwd: site, tracker });
    expect(dirty.exitCode).toBe(1);
    expect(dirty.stderr).toMatch(/not committed/);
    git(site, "checkout", "--", "design");

    const other = tracker.addSpec("Another Spec");
    tracker.addTicket(other, "Its Ticket", "", ["stage:spec"]);
    await tracker.moveToStage(other, "design");
    const foreign = await runFactory(["design", "approve", String(other)], { cwd: site, tracker });
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr).toMatch(new RegExp(`not made for Spec #${other}`));

    expect(labels(tracker, ticket)).toEqual(["stage:spec"]);
    expect(labels(tracker, spec)).toEqual(["stage:design"]);
  });

  it("explains the arguments it needs", async () => {
    const run = await runFactory(["design", "approve"], { cwd: process.cwd(), tracker: new FakeTracker() });
    expect(run.exitCode).toBe(2);
  });
});

describe("the code/design Review check", () => {
  let served: ServedSite;
  let repo: FixtureRepo | undefined;

  beforeAll(async () => {
    served = await serveFixtureSite("clean");
  });
  afterAll(async () => {
    await served.close();
  });
  afterEach(async () => {
    await repo?.remove();
    repo = undefined;
  });

  async function check(fixture: string, change: (dir: string) => void = () => {}) {
    repo = await copyFixtureRepo(fixture, "http://127.0.0.1:9/");
    change(repo.dir);
    const run = await runFactory(["review", served.url, "--json", "--check", "code/design"], { cwd: repo.dir });
    const report = JSON.parse(run.stdout) as { passed: boolean; areas: { checks: { id: string; skipped?: string; failures: { reason: string; location: string }[] }[] }[] };
    return { exitCode: run.exitCode, ...report.areas.flatMap((area) => area.checks).find((found) => found.id === "code/design")! };
  }

  it("passes a handoff that stands", async () => {
    expect(await check("design-clean")).toMatchObject({ exitCode: 0, failures: [] });
  });

  it("fails a DESIGN.md with failing contrast, with a plain reason and where", async () => {
    const { exitCode, failures } = await check("design-low-contrast");
    expect(exitCode).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/too hard to read/);
    expect(failures[0]!.location).toBe("design/DESIGN.md at components.page");
  });

  it("fails see-through text, which the linter's contrast rule cannot measure", async () => {
    const { exitCode, failures } = await check("design-see-through-text");
    expect(exitCode).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/textColor #00000010 is see-through/);
    expect(failures[0]!.location).toBe("design/DESIGN.md at components.page");
  });

  it("fails hand-edited tokens that no longer match DESIGN.md", async () => {
    const { exitCode, failures } = await check("design-hand-edited-tokens");
    expect(exitCode).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/no longer matches DESIGN\.md.*color\.primary/);
    expect(failures[0]!.location).toBe("design/tokens.json");
  });

  it("fails a route with no reference screenshot", async () => {
    const { failures } = await check("design-no-screenshot");
    expect(failures.map((failure) => failure.location)).toEqual(["design/screenshots/home.png"]);
  });

  it("reports a Site that never had a handoff as not run, and one that deleted it as failed", async () => {
    expect((await check("clean")).skipped).toMatch(/no Design handoff yet/);
    await repo?.remove();

    const { failures } = await check("design-clean", (dir) => {
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "handoff");
      rmSync(`${dir}/design/DESIGN.md`);
    });
    expect(failures.map((failure) => failure.location)).toContain("design/DESIGN.md");
  });
});

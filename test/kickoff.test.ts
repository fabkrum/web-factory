import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentCliChoice, readSiteConfig } from "../src/config.ts";
import { STAGES, stageLabel } from "../src/stages.ts";
import { delegateTo, FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

const TEMPLATE_AGENTS = readFileSync(resolve(import.meta.dirname, "..", "packages/create-web-factory/template/AGENTS.md"), "utf8");

/** What the kickoff skill writes after its conversation with the Builder. */
function decisions(overrides: Record<string, unknown> = {}) {
  return {
    site: { audience: "Guests of a small cafe", purpose: "Show the menu and opening hours", changeFrequency: "A few times a year" },
    location: { operatorCountry: "AT", visitorCountries: ["AT"] },
    agentCli: "codex",
    stack: {
      chosen: "Astro",
      recommended: "Astro",
      reason: "The Builder wants a fast Site with little JavaScript.",
      options: [
        { name: "Astro", for: "Static pages by default", against: "One more tool to learn" },
        { name: "Plain HTML", for: "Nothing to install", against: "Shared headers are copied by hand" },
      ],
    },
    host: {
      chosen: "Firebase Hosting",
      recommended: "Firebase Hosting",
      reason: "It is free at this size and gives a Preview per pull request.",
      options: [
        { name: "Firebase Hosting", for: "Preview channels built in", against: "Needs a Google account" },
        { name: "Cloudflare Pages", for: "Generous free plan", against: "Its own setup, without a Factory adapter" },
      ],
    },
    commands: { test: "npm test", build: "npm run build", serve: "npx astro preview --port {port}" },
    ...overrides,
  };
}

/** A Site as `npm create web-factory` leaves it: the template's AGENTS.md, no factory.json yet. */
function newSite(): string {
  const site = createSiteRepo({ testCommand: "true" });
  git(site, "rm", "-q", "factory.json");
  commitFile(site, "AGENTS.md", TEMPLATE_AGENTS, "Start the Site with the Factory");
  return site;
}

async function kickoff(site: string, chosen: unknown, tracker = new FakeTracker()) {
  writeFile(site, ".git/kickoff.json", JSON.stringify(chosen));
  const run = await runFactory(["kickoff", ".git/kickoff.json"], { cwd: site, tracker });
  return { ...run, tracker };
}

const read = (site: string, path: string) => readFileSync(join(site, path), "utf8");
const adrs = (site: string) => readdirSync(join(site, "docs/adr")).sort();
const config = (site: string) => JSON.parse(read(site, "factory.json")) as Record<string, unknown>;

describe("factory kickoff", () => {
  it("records the Builder's choices as ADRs and a Stack section with the test command and the host, and commits them", async () => {
    const site = newSite();

    const run = await kickoff(site, decisions());

    expect(run.exitCode, run.stderr).toBe(0);
    expect(adrs(site)).toEqual(["0001-stack.md", "0002-host.md"]);
    const agents = read(site, "AGENTS.md");
    expect(agents).toContain("## Stack");
    expect(agents).not.toContain("Not decided yet");
    expect(agents).toContain("Astro");
    expect(agents).toContain("`npm test`");
    expect(agents).toContain("Firebase Hosting");
    expect(agents).toMatch(/## Required reading: Modern Web Guidance/);
    expect(git(site, "status", "--porcelain")).toBe("");
    expect(git(site, "log", "-1", "--name-only", "--format=")).toContain("factory.json");
  });

  it("records the build, serve and test commands where Review reads them, and in the Stack section", async () => {
    const site = newSite();

    await kickoff(site, decisions());

    expect(await readSiteConfig(site)).toMatchObject({ testCommand: "npm test", buildCommand: "npm run build", serveCommand: "npx astro preview --port {port}" });
    const agents = read(site, "AGENTS.md");
    for (const command of ["npm test", "npm run build", "npx astro preview --port {port}"]) expect(agents).toContain(`\`${command}\``);
  });

  it("says plainly that a Site without a build step has none", async () => {
    const site = newSite();

    await kickoff(site, decisions({ commands: { test: "npm test", serve: "npx serve -l {port}" } }));

    expect((await readSiteConfig(site)).buildCommand).toBeUndefined();
    expect(read(site, "AGENTS.md")).toMatch(/Build command: none/);
  });

  it("keeps every option offered in its ADR with the case for and against", async () => {
    const site = newSite();

    await kickoff(site, decisions());

    const stack = read(site, "docs/adr/0001-stack.md");
    for (const text of ["Astro", "Static pages by default", "One more tool to learn", "Plain HTML", "Nothing to install", "Shared headers are copied by hand", "little JavaScript", "Guests of a small cafe"]) {
      expect(stack).toContain(text);
    }
    const host = read(site, "docs/adr/0002-host.md");
    for (const text of ["Firebase Hosting", "Preview channels built in", "Needs a Google account", "Cloudflare Pages", "Generous free plan", "Its own setup, without a Factory adapter"]) {
      expect(host).toContain(text);
    }
  });

  it("records the Agent CLI the Builder named", async () => {
    const site = newSite();

    await kickoff(site, decisions({ agentCli: "antigravity" }));

    expect(await readAgentCliChoice(site)).toBe("antigravity");
    expect(read(site, "AGENTS.md")).toContain("antigravity");
  });

  it("has no default Agent CLI: without the Builder's answer it refuses and changes nothing", async () => {
    const site = newSite();
    const { agentCli: _, ...withoutAgentCli } = decisions();

    const run = await kickoff(site, withoutAgentCli);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Agent CLI/);
    expect(run.stderr).toContain("claude-code, codex, antigravity and gemini");
    expect(existsSync(join(site, "factory.json"))).toBe(false);
    expect(await run.tracker.labels()).toEqual([]);
  });

  it("refuses an Agent CLI the Factory has no adapter for", async () => {
    const run = await kickoff(newSite(), decisions({ agentCli: "copilot" }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("copilot");
  });

  it.each([
    ["an operator in Germany", { operatorCountry: "DE", visitorCountries: ["AT"] }],
    ["Visitors in Germany", { operatorCountry: "US", visitorCountries: ["US", "DE"] }],
  ])("switches the German Locale pack on for %s", async (_, location) => {
    const site = newSite();

    const run = await kickoff(site, decisions({ location }));

    expect(config(site).localePack).toBe("de");
    expect(read(site, "AGENTS.md")).toMatch(/German Locale pack/);
    expect(run.stdout).toMatch(/German Locale pack is on/);
    expect(run.stdout).toMatch(/not legal advice/);
  });

  it("leaves the Locale pack off outside Germany and says that this is not legal advice", async () => {
    const site = newSite();

    const run = await kickoff(site, decisions());

    expect(config(site)).not.toHaveProperty("localePack");
    expect(run.stdout).toMatch(/only the generic checks/);
    expect(run.stdout).toMatch(/not legal advice/);
  });

  it("refuses a country that is not a two-letter code, so a spelling never leaves the pack off", async () => {
    const site = newSite();

    const run = await kickoff(site, decisions({ location: { operatorCountry: "Deutschland", visitorCountries: ["DE"] } }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Deutschland");
    expect(existsSync(join(site, "factory.json"))).toBe(false);
  });

  it("creates the Stage labels", async () => {
    const run = await kickoff(newSite(), decisions());

    expect(await run.tracker.labels()).toEqual(expect.arrayContaining(STAGES.map(stageLabel)));
  });

  it("names Firebase's own connection to GitHub as the next step", async () => {
    const site = newSite();

    const run = await kickoff(site, decisions());

    expect(run.stdout).toMatch(/Next step/);
    expect(run.stdout).toMatch(/Firebase/);
  });

  it("records the setup of any other host as the Builder's next step", async () => {
    const site = newSite();
    const setup = "Connect the repository in the Cloudflare dashboard under Workers & Pages.";
    const host = { ...decisions().host, chosen: "Cloudflare Pages", setup };

    const run = await kickoff(site, decisions({ host }));

    expect(run.exitCode, run.stderr).toBe(0);
    expect(config(site).host).toBe("Cloudflare Pages");
    expect(read(site, "AGENTS.md")).toContain(setup);
    expect(read(site, "docs/adr/0002-host.md")).toContain(setup);
    expect(run.stdout).toContain(setup);
  });

  it("refuses another host without its setup, since nothing else would connect it", async () => {
    const site = newSite();
    const host = { ...decisions().host, chosen: "Cloudflare Pages" };

    const run = await kickoff(site, decisions({ host }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Cloudflare Pages/);
    expect(run.stderr).toMatch(/setup/);
  });

  it.each([
    ["a chosen stack that was not offered", { stack: { ...decisions().stack, chosen: "Next.js" } }, /Next\.js/],
    ["a recommendation that was not offered", { stack: { ...decisions().stack, recommended: "Next.js" } }, /Next\.js/],
    ["a single option, which is no choice", { host: { ...decisions().host, options: decisions().host.options.slice(0, 1) } }, /at least two/],
    ["an option without its case against", { stack: { ...decisions().stack, options: [{ name: "Astro", for: "Fast", against: " " }, decisions().stack.options[1]] } }, /against/],
    ["no test command", { commands: { serve: "npx serve" } }, /commands\.test/],
    ["no serve command", { commands: { test: "npm test" } }, /commands\.serve/],
    ["a setup with a heading line, which would split the Stack section", { host: { ...decisions().host, chosen: "Cloudflare Pages", setup: "Do this:\n## Dashboard\nConnect it." } }, /## /],
    ["a command with a heading line, which would split the Stack section", { commands: { test: "npm test\n## Serve", serve: "npx serve" } }, /## /],
  ])("refuses %s and changes nothing", async (_, overrides, reason) => {
    const site = newSite();

    const run = await kickoff(site, decisions(overrides));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(reason);
    expect(existsSync(join(site, "docs/adr"))).toBe(false);
    expect(read(site, "AGENTS.md")).toBe(TEMPLATE_AGENTS);
  });

  it("keeps the settings factory.json already had", async () => {
    const site = newSite();
    commitFile(site, "factory.json", JSON.stringify({ testCommand: "old", baseBranch: "trunk", maxAttempts: 5 }));

    await kickoff(site, decisions());

    expect(config(site)).toMatchObject({ testCommand: "npm test", baseBranch: "trunk", maxAttempts: 5 });
  });

  it("keeps the record when GitHub cannot be reached, says what to do, and finishes when run again", async () => {
    const site = newSite();
    const tracker = new FakeTracker();
    const unreachable = {
      ...delegateTo(tracker),
      ensureStageLabels: async () => {
        throw new Error("gh: not logged in");
      },
    };

    const failed = await kickoff(site, decisions(), unreachable as unknown as FakeTracker);

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toMatch(/GitHub/);
    expect(failed.stderr).toMatch(/run .*again/i);
    expect(read(site, "AGENTS.md")).toContain("Astro");
    const commit = git(site, "rev-parse", "HEAD");

    const second = await kickoff(site, decisions(), tracker);

    expect(second.exitCode, second.stderr).toBe(0);
    expect(await tracker.labels()).toEqual(expect.arrayContaining(STAGES.map(stageLabel)));
    expect(git(site, "rev-parse", "HEAD")).toBe(commit);
  });

  it.each(["Firebase App Hosting", "firebase-app-hosting", "App Hosting"])("refuses %s, with its own setup too: v1 needs a Preview per Ticket and it has none", async (chosen) => {
    const site = newSite();
    const option = { name: chosen, for: "Runs a server", against: "No preview channels" };
    const host = { ...decisions().host, chosen, options: [...decisions().host.options, option], setup: "Connect it in the console." };

    const run = await kickoff(site, decisions({ host }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Preview/);
    expect(run.stderr).toMatch(/static/);
    expect(existsSync(join(site, "docs/adr"))).toBe(false);
  });

  it.each(["Firebase Functions", "Netlify (not Firebase)"])("asks %s for its own setup: only Firebase Hosting has an adapter", async (chosen) => {
    const site = newSite();
    const option = { name: chosen, for: "Fits", against: "No adapter" };
    const host = { ...decisions().host, chosen, options: [...decisions().host.options, option] };

    const run = await kickoff(site, decisions({ host }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/setup/);
  });

  it.each([
    ["a line break", "Connect it in the dashboard.\n"],
    ["a space", "Connect it in the dashboard. "],
  ])("finishes when run again with a host setup that ends in %s", async (_, setup) => {
    const site = newSite();
    const tracker = new FakeTracker();
    const unreachable = {
      ...delegateTo(tracker),
      ensureStageLabels: async () => {
        throw new Error("gh: not logged in");
      },
    };
    const host = { ...decisions().host, chosen: "Cloudflare Pages", setup };

    const failed = await kickoff(site, decisions({ host }), unreachable as unknown as FakeTracker);
    expect(failed.exitCode).toBe(1);

    const second = await kickoff(site, decisions({ host }), tracker);

    expect(second.exitCode, second.stderr).toBe(0);
    expect(await tracker.labels()).toEqual(expect.arrayContaining(STAGES.map(stageLabel)));
    expect(second.stdout).toContain("Next step: Connect it in the dashboard.\n");
  });

  it("will not replace decisions already recorded: that is a new Architecture decision in a Spec", async () => {
    const site = newSite();
    await kickoff(site, decisions());
    const before = read(site, "docs/adr/0001-stack.md");
    const commit = git(site, "rev-parse", "HEAD");

    const run = await kickoff(site, decisions({ stack: { ...decisions().stack, chosen: "Plain HTML" } }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Architecture decision/);
    expect(read(site, "docs/adr/0001-stack.md")).toBe(before);
    expect(git(site, "rev-parse", "HEAD")).toBe(commit);
  });

  it("leaves what the Builder has staged out of its commit", async () => {
    const site = newSite();
    writeFile(site, "notes.txt", "mine\n");
    git(site, "add", "notes.txt");

    await kickoff(site, decisions());

    expect(git(site, "status", "--porcelain")).toBe("A  notes.txt");
  });

  it.each([
    ["a file that is not there", null, /could not be read/],
    ["a file that is not JSON", "not json", /not valid JSON/],
  ])("refuses %s", async (_, content, reason) => {
    const site = newSite();
    if (content !== null) writeFile(site, ".git/kickoff.json", content);

    const run = await runFactory(["kickoff", ".git/kickoff.json"], { cwd: site, tracker: new FakeTracker() });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(reason);
  });

  it("needs the file with the decisions", async () => {
    const run = await runFactory(["kickoff"], { cwd: newSite(), tracker: new FakeTracker() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("factory kickoff <decisions-file>");
  });
});

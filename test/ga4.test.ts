import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/review/browser.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { copyFixtureRepo, type FixtureRepo } from "./harness/fixture-repo.ts";
import type { ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages, type Answer } from "./harness/served-pages.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

const TEMPLATE_AGENTS = readFileSync(resolve(import.meta.dirname, "..", "packages/create-web-factory/template/AGENTS.md"), "utf8");

const GOOGLE = "https://www.googletagmanager.com/";

/** A plain-HTML Site after `factory kickoff` with the GA4 opt-in, its operator in the given country. */
async function siteWithGa4(operatorCountry: "DE" | "AT"): Promise<string> {
  const site = createSiteRepo({ testCommand: "true" });
  git(site, "rm", "-q", "factory.json");
  commitFile(site, "AGENTS.md", TEMPLATE_AGENTS, "Start the Site with the Factory");
  const option = (name: string) => ({ name, for: "Fits", against: "Costs" });
  const choice = (chosen: string, other: string) => ({ chosen, recommended: chosen, reason: "It fits.", options: [option(chosen), option(other)] });
  const decisions = {
    site: { audience: "Guests of a small cafe", purpose: "Show the menu", changeFrequency: "Rarely" },
    location: { operatorCountry, visitorCountries: [operatorCountry] },
    agentCli: "codex",
    stack: choice("Plain HTML", "Astro"),
    host: choice("Firebase Hosting", "Cloudflare Pages"),
    commands: { test: "true", serve: "npx serve -l {port}" },
    ga4: { measurementId: "G-AB12CD34EF", publicDir: "." },
  };
  writeFile(site, ".git/kickoff.json", JSON.stringify(decisions));
  const run = await runFactory(["kickoff", ".git/kickoff.json"], { cwd: site, tracker: new FakeTracker() });
  expect(run.exitCode, run.stderr).toBe(0);
  return site;
}

/** A page that passes the German pack's link checks and loads the reporter as AGENTS.md says. */
function legalPage(): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Café</title><script type="module" src="/web-vitals/ga4.js"></script></head>
<body><main><h1>Café</h1><p>Willkommen.</p></main><footer><a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer></body></html>`;
}

const servers: ServedSite[] = [];
let repo: FixtureRepo | undefined;

/** Serves the Site's pages with the reporter Kickoff wrote. */
async function serve(site: string): Promise<ServedSite> {
  const script = (path: string): Answer => ({ headers: { "content-type": "text/javascript; charset=utf-8" }, body: readFileSync(join(site, path), "utf8") });
  const served = await servePages({
    "/": legalPage(),
    "/impressum": legalPage(),
    "/datenschutz": legalPage(),
    "/web-vitals/ga4.js": script("web-vitals/ga4.js"),
    "/web-vitals/web-vitals.js": script("web-vitals/web-vitals.js"),
  });
  servers.push(served);
  return served;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await repo?.remove();
  repo = undefined;
});

describe("web-vitals to GA4 with the German Locale pack on", () => {
  it("passes the consent Review checks: nothing is sent before consent", async () => {
    const site = await serve(await siteWithGa4("DE"));
    repo = await copyFixtureRepo("german-locale-pack", "http://127.0.0.1:9/");

    const run = await runFactory(["review", site.url, "--json", "--check", "legal/third-party-requests", "--check", "legal/third-party-fonts"], { cwd: repo.dir });

    const report = JSON.parse(run.stdout) as { passed: boolean; areas: { checks: { id: string; passed: boolean; failures: unknown[] }[] }[] };
    const checks = report.areas.flatMap((area) => area.checks);
    expect(checks.map((check) => check.id).sort()).toEqual(["legal/third-party-fonts", "legal/third-party-requests"]);
    expect(checks.flatMap((check) => check.failures)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(run.exitCode, run.stderr).toBe(0);
  });
});

describe("the reporter in a Visitor's browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** Opens the Site with Google answered locally, and records every request to Google. */
  async function open(site: ServedSite) {
    const context = await browser.newContext();
    const toGoogle: string[] = [];
    await context.route(`${GOOGLE}**`, (route) => {
      toGoogle.push(route.request().url());
      return route.fulfill({ contentType: "text/javascript", body: "" });
    });
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: "load" });
    const events = () => page.evaluate(() => ((window as unknown as { dataLayer: IArguments[] }).dataLayer ?? []).map((entry) => Array.from(entry)).filter(([kind]) => kind === "event").map(([, name]) => name));
    return { context, page, toGoogle, events };
  }

  it("measures without sending, then loads Google's script once the Visitor agrees, and remembers it", async () => {
    const site = await serve(await siteWithGa4("DE"));
    const { context, page, toGoogle, events } = await open(site);
    try {
      await expect.poll(events).toContain("TTFB");
      await page.waitForTimeout(500);
      expect(toGoogle).toEqual([]);

      await page.evaluate(() => (window as unknown as { grantAnalyticsConsent: () => void }).grantAnalyticsConsent());
      await expect.poll(() => toGoogle).toEqual([`${GOOGLE}gtag/js?id=G-AB12CD34EF`]);

      await page.reload({ waitUntil: "load" });
      await expect.poll(() => toGoogle.length).toBe(2);

      await page.evaluate(() => (window as unknown as { withdrawAnalyticsConsent: () => void }).withdrawAnalyticsConsent());
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(500);
      expect(toGoogle).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("loads Google's script with the page when no consent is asked for", async () => {
    const site = await serve(await siteWithGa4("AT"));
    const { context, toGoogle, events } = await open(site);
    try {
      await expect.poll(() => toGoogle).toEqual([`${GOOGLE}gtag/js?id=G-AB12CD34EF`]);
      await expect.poll(events).toContain("TTFB");
    } finally {
      await context.close();
    }
  });
});

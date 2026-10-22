import { afterEach, describe, expect, it } from "vitest";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages, type Answer } from "./harness/served-pages.ts";

interface JsonReport {
  passed: boolean;
  routes: string[];
  areas: { area: string; checks: { id: string; passed: boolean; failures: { reason: string; location: string }[] }[] }[];
}

const VISIBILITY_CHECKS = [
  "visibility/sitemap",
  "visibility/canonical",
  "visibility/one-url",
  "visibility/social-preview",
  "visibility/structured-data",
];

let site: ServedSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

/**
 * Every check but Lighthouse, whose repeated runs on every route add minutes and
 * no coverage here: a defect must fail exactly its own Visibility check and no
 * other. test/review.test.ts runs every check on the clean fixture.
 */
async function reviewJson(url: string) {
  const checks = ["accessibility/axe", ...VISIBILITY_CHECKS].flatMap((id) => ["--check", id]);
  const run = await runFactory(["review", url, "--json", ...checks], { cwd: process.cwd() });
  return { run, report: JSON.parse(run.stdout) as JsonReport };
}

async function reviewFixture(fixture: string) {
  site = await serveFixtureSite(fixture);
  return reviewJson(site.url);
}

async function reviewPages(pages: Record<string, Answer>) {
  site = await servePages(pages);
  return reviewJson(site.url);
}

function failingChecks(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks.filter((check) => !check.passed).map((check) => check.id));
}

function failuresOf(report: JsonReport, id: string) {
  return report.areas.find((area) => area.area === "Visibility")!.checks.find((check) => check.id === id)!.failures;
}

/** A page that passes every Visibility check on its own: canonical to `path`, social preview tags, valid structured data. */
function visiblePage(path: string, links: string[], head = ""): string {
  const nav = links.map((href) => `<a href="${href}">Go to ${href}</a>`).join(" ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page ${path}</title>
<link rel="canonical" href="https://www.example.com${path}">
<meta property="og:title" content="Page ${path}"><meta property="og:description" content="A page."><meta property="og:image" content="https://www.example.com/social.png">
${head}</head><body style="color: #1a1a1a; background: #ffffff"><nav aria-label="Main">${nav}</nav><main><h1>Page ${path}</h1></main></body></html>`;
}

function sitemap(...paths: string[]): Answer {
  const urls = paths.map((path) => `<url><loc>https://www.example.com${path}</loc></url>`).join("");
  return { headers: { "content-type": "application/xml" }, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>` };
}

describe("the Visibility Review checks", () => {
  it("pass the clean fixture", async () => {
    const { run, report } = await reviewFixture("clean");

    expect(failingChecks(report)).toEqual([]);
    expect(run.exitCode).toBe(0);
    const visibility = report.areas.find((area) => area.area === "Visibility")!;
    expect(visibility.checks.map((check) => check.id)).toEqual(VISIBILITY_CHECKS);
  });

  it("fail a sitemap that misses a route, naming the route", async () => {
    const { run, report } = await reviewFixture("sitemap-missing-route");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/sitemap"]);
    const [failure, ...others] = failuresOf(report, "visibility/sitemap");
    expect(others).toEqual([]);
    expect(failure!.location).toBe("/about.html");
    expect(failure!.reason).toMatch(/sitemap/i);
    expect(failure!.reason).toMatch(/\/about\.html/);
  });

  it("fail a Site without a sitemap", async () => {
    const { run, report } = await reviewPages({ "/": visiblePage("/", []) });

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/sitemap"]);
    expect(failuresOf(report, "visibility/sitemap")[0]!.reason).toMatch(/no sitemap/i);
  });

  it("find the sitemap robots.txt names, and follow a sitemap index", async () => {
    const { run, report } = await reviewPages({
      "/": visiblePage("/", ["/about"]),
      "/about": visiblePage("/about", ["/"]),
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nSitemap: https://www.example.com/maps/index.xml\n" },
      "/maps/index.xml": {
        headers: { "content-type": "application/xml" },
        body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://www.example.com/maps/pages.xml</loc></sitemap></sitemapindex>`,
      },
      "/maps/pages.xml": sitemap("/", "/about/"),
    });

    expect(failingChecks(report)).toEqual([]);
    expect(run.exitCode).toBe(0);
  });

  it("fail a page without a canonical URL", async () => {
    const { run, report } = await reviewFixture("missing-canonical");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/canonical"]);
    const [failure, ...others] = failuresOf(report, "visibility/canonical");
    expect(others).toEqual([]);
    expect(failure!.location).toBe("/about.html");
    expect(failure!.reason).toMatch(/no canonical/i);
  });

  it("fail a canonical URL that points at another page, naming both", async () => {
    const { run, report } = await reviewFixture("wrong-canonical");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/canonical"]);
    const [failure, ...others] = failuresOf(report, "visibility/canonical");
    expect(others).toEqual([]);
    expect(failure!.location).toBe("/about.html");
    expect(failure!.reason).toContain("https://www.example.com/");
    expect(failure!.reason).toContain("/about.html");
  });

  it("fail a page reachable at two URLs, naming the other one", async () => {
    const { run, report } = await reviewFixture("duplicate-url");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/one-url"]);
    const [failure, ...others] = failuresOf(report, "visibility/one-url");
    expect(others).toEqual([]);
    expect(failure!.location).toBe("/about.html");
    expect(failure!.reason).toContain("/about/");
  });

  it("fail two linked routes that serve the same page once, not once each", async () => {
    const about = visiblePage("/about", ["/"]);
    const { report } = await reviewPages({
      "/": visiblePage("/", ["/about", "/about-us"]),
      "/about": about,
      "/about-us": about,
      "/sitemap.xml": sitemap("/", "/about", "/about-us"),
    });

    const failures = failuresOf(report, "visibility/one-url");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.location).toBe("/about");
    expect(failures[0]!.reason).toContain("/about-us");
  });

  it("pass a page whose other forms redirect to it", async () => {
    const { run, report } = await reviewPages({
      "/": visiblePage("/", ["/about"]),
      "/index.html": { status: 301, headers: { location: "/" } },
      "/about": visiblePage("/about", ["/"]),
      "/about/": { status: 301, headers: { location: "/about" } },
      "/about.html": { status: 301, headers: { location: "/about" } },
      "/sitemap.xml": sitemap("/", "/about"),
    });

    expect(failingChecks(report)).toEqual([]);
    expect(run.exitCode).toBe(0);
  });

  it("fail a page without social preview tags, naming the missing tags", async () => {
    const { run, report } = await reviewFixture("missing-social-preview");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/social-preview"]);
    const [failure, ...others] = failuresOf(report, "visibility/social-preview");
    expect(others).toEqual([]);
    expect(failure!.location).toBe("/about.html");
    expect(failure!.reason).toContain("og:description");
    expect(failure!.reason).toContain("og:image");
    expect(failure!.reason).not.toContain("og:title");
  });

  it("fail a social preview image that is not a full address", async () => {
    const { report } = await reviewPages({
      "/": visiblePage("/", []).replace("https://www.example.com/social.png", "/social.png"),
      "/sitemap.xml": sitemap("/"),
    });

    expect(failingChecks(report)).toEqual(["visibility/social-preview"]);
    expect(failuresOf(report, "visibility/social-preview")[0]!.reason).toMatch(/og:image.*full address/);
  });

  it("fail structured data that does not parse, naming the error", async () => {
    const { run, report } = await reviewFixture("broken-structured-data");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["visibility/structured-data"]);
    const [failure, ...others] = failuresOf(report, "visibility/structured-data");
    expect(others).toEqual([]);
    expect(failure!.location).toMatch(/^\/about\.html/);
    expect(failure!.reason).toMatch(/does not parse/);
    expect(failure!.reason).toMatch(/JSON at position \d+/);
  });

  it("fail structured data that parses but says nothing a search engine can use", async () => {
    const { report } = await reviewPages({
      "/": visiblePage("/", [], `<script type="application/ld+json">{"name": "No type"}</script>`),
      "/sitemap.xml": sitemap("/"),
    });

    expect(failingChecks(report)).toEqual(["visibility/structured-data"]);
    expect(failuresOf(report, "visibility/structured-data")[0]!.reason).toMatch(/@context/);
  });
});

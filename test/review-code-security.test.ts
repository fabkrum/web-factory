import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { serveFakeNpmRegistry, type FakeNpmRegistry } from "./harness/fake-npm-registry.ts";
import { copyFixtureRepo, type FixtureRepo } from "./harness/fixture-repo.ts";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages, type Answer } from "./harness/served-pages.ts";

interface JsonReport {
  passed: boolean;
  areas: {
    area: string;
    checks: { id: string; passed: boolean; skipped?: string; failures: { reason: string; location: string }[] }[];
  }[];
}

const CODE_CHECKS = ["security/headers", "code/console", "security/advisories", "code/site-tests"];

/**
 * Every check but Lighthouse, whose repeated runs add minutes and no coverage
 * here: a defect must fail exactly its own check and no other.
 */
const CHECKS = [
  "accessibility/axe",
  "visibility/sitemap",
  "visibility/canonical",
  "visibility/one-url",
  "visibility/social-preview",
  "visibility/structured-data",
  ...CODE_CHECKS,
];

let registry: FakeNpmRegistry;
let site: ServedSite | undefined;
let repo: FixtureRepo | undefined;

beforeAll(async () => {
  registry = await serveFakeNpmRegistry(
    [
      {
        package: "fixture-lib",
        title: "Prototype pollution in fixture-lib",
        url: "https://github.com/advisories/GHSA-fx7p-2x4m-9q3c",
        severity: "high",
        vulnerableVersions: "<1.2.0",
      },
    ],
    { "fixture-lib": ["1.1.0", "1.2.0"] },
  );
});

afterAll(async () => {
  await registry.close();
});

afterEach(async () => {
  await site?.close();
  site = undefined;
  await repo?.remove();
  repo = undefined;
});

/** Reviews the served Site from the folder of a fixture Site repository, as a Builder runs it from their Site's folder. */
async function review(url: string, repoFixture: string | undefined, checks = CHECKS) {
  let cwd = process.cwd();
  if (repoFixture) {
    repo = await copyFixtureRepo(repoFixture, registry.url);
    cwd = repo.dir;
  }
  const run = await runFactory(["review", url, "--json", ...checks.flatMap((id) => ["--check", id])], { cwd });
  return { run, report: JSON.parse(run.stdout) as JsonReport };
}

async function reviewFixture(fixture: string, repoFixture: string | undefined = "clean") {
  site = await serveFixtureSite(fixture);
  return review(site.url, repoFixture);
}

async function reviewPages(pages: Record<string, Answer>) {
  site = await servePages(pages);
  return review(site.url, "clean", ["security/headers", "code/console"]);
}

function failingChecks(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks.filter((check) => !check.passed).map((check) => check.id));
}

function checkOf(report: JsonReport, id: string) {
  return report.areas.find((area) => area.area === "Code & security")!.checks.find((check) => check.id === id)!;
}

const SAFE_HEADERS = { "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff" };

describe("the Code & security Review checks", () => {
  it("pass the clean fixture from a clean Site repository", async () => {
    const { run, report } = await reviewFixture("clean");

    expect(failingChecks(report)).toEqual([]);
    expect(run.exitCode).toBe(0);
    const area = report.areas.find((area) => area.area === "Code & security")!;
    expect(area.checks.map((check) => check.id)).toEqual(CODE_CHECKS);
    expect(area.checks.filter((check) => check.skipped)).toEqual([]);
  });

  it("fail a Site served without a content security policy, naming the missing header on every route", async () => {
    const { run, report } = await reviewFixture("missing-csp");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["security/headers"]);
    const failures = checkOf(report, "security/headers").failures;
    expect(failures.map((failure) => failure.location)).toEqual(["/", "/about.html"]);
    for (const failure of failures) {
      expect(failure.reason).toMatch(/Content-Security-Policy/);
      expect(failure.reason).not.toMatch(/X-Content-Type-Options/);
      expect(failure.reason).not.toMatch(/X-Frame-Options/);
    }
  });

  it("name every security header a page is missing", async () => {
    const { report } = await reviewPages({ "/": "<!doctype html><html lang=en><title>Bare</title><h1>Bare</h1></html>" });

    const [failure, ...others] = checkOf(report, "security/headers").failures;
    expect(others).toEqual([]);
    expect(failure!.location).toBe("/");
    expect(failure!.reason).toMatch(/Content-Security-Policy/);
    expect(failure!.reason).toMatch(/X-Content-Type-Options/);
    expect(failure!.reason).toMatch(/X-Frame-Options|frame-ancestors/);
  });

  it("accept a policy set in a meta tag, and frame protection from X-Frame-Options", async () => {
    const { report } = await reviewPages({
      "/": {
        headers: { "x-content-type-options": "nosniff", "x-frame-options": "DENY" },
        body: `<!doctype html><html lang=en><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>Meta</title></head><h1>Meta</h1></html>`,
      },
    });

    expect(failingChecks(report)).toEqual([]);
  });

  it("fail a policy that only reports, saying it enforces nothing", async () => {
    const { report } = await reviewPages({
      "/": {
        headers: { "content-security-policy-report-only": "default-src 'self'", "x-content-type-options": "nosniff", "x-frame-options": "DENY" },
        body: "<!doctype html><html lang=en><title>Report only</title><h1>Report only</h1></html>",
      },
    });

    expect(failingChecks(report)).toEqual(["security/headers"]);
    expect(checkOf(report, "security/headers").failures[0]!.reason).toMatch(/report/i);
  });

  it("fail a console error on any route, with the message and the route", async () => {
    const { run, report } = await reviewFixture("console-error");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["code/console"]);
    const [failure, ...others] = checkOf(report, "code/console").failures;
    expect(others).toEqual([]);
    expect(failure!.location).toMatch(/^\/about\.html\b/);
    expect(failure!.reason).toContain("Newsletter form could not start: no API key set");
  });

  it("fail an uncaught error and a file the page cannot load", async () => {
    const { report } = await reviewPages({
      "/": {
        headers: SAFE_HEADERS,
        body: `<!doctype html><html lang=en><head><title>Broken</title><script src="/missing.js"></script></head><body><h1>Broken</h1><script src="/app.js"></script></body></html>`,
      },
      "/app.js": { headers: { ...SAFE_HEADERS, "content-type": "text/javascript" }, body: "document.querySelector('#menu').addEventListener('click', () => {});" },
    });

    expect(failingChecks(report)).toEqual(["code/console"]);
    const reasons = checkOf(report, "code/console").failures.map((failure) => failure.reason);
    expect(reasons).toHaveLength(2);
    expect(reasons.some((reason) => /404/.test(reason) && reason.includes("/missing.js"))).toBe(true);
    expect(reasons.some((reason) => /null|addEventListener/.test(reason))).toBe(true);
  });

  it("count a script the Site's own policy blocks as a console error", async () => {
    const { report } = await reviewPages({
      "/": {
        headers: SAFE_HEADERS,
        body: `<!doctype html><html lang=en><head><title>Blocked</title></head><body><h1>Blocked</h1><script>document.title = "ran";</script></body></html>`,
      },
    });

    expect(failingChecks(report)).toEqual(["code/console"]);
    expect(checkOf(report, "code/console").failures[0]!.reason).toMatch(/Content Security Policy/i);
  });

  it("fail a red Site test command, with the command and what it printed", async () => {
    site = await serveFixtureSite("clean");
    const { run, report } = await review(site.url, "red-tests");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["code/site-tests"]);
    const [failure, ...others] = checkOf(report, "code/site-tests").failures;
    expect(others).toEqual([]);
    expect(failure!.reason).toMatch(/red|failed/i);
    expect(failure!.reason).toContain("contact form: expected a thank-you message, got nothing");
    expect(failure!.location).toContain("node -e");
  });

  it("fail a dependency with a known advisory, naming the advisory", async () => {
    site = await serveFixtureSite("clean");
    const { run, report } = await review(site.url, "vulnerable-dependency");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["security/advisories"]);
    const [failure, ...others] = checkOf(report, "security/advisories").failures;
    expect(others).toEqual([]);
    expect(failure!.location).toMatch(/fixture-lib/);
    expect(failure!.reason).toContain("Prototype pollution in fixture-lib");
    expect(failure!.reason).toContain("https://github.com/advisories/GHSA-fx7p-2x4m-9q3c");
    expect(failure!.reason).toMatch(/high/);
    expect(failure!.reason).toContain("1.2.0");
  });

  it("fail a Site whose dependencies have no lockfile to audit", async () => {
    site = await serveFixtureSite("clean");
    const { report } = await review(site.url, "no-lockfile");

    expect(failingChecks(report)).toEqual(["security/advisories"]);
    expect(checkOf(report, "security/advisories").failures[0]!.reason).toMatch(/package-lock\.json/);
  });

  it("report the advisories check as not run, not failed, for a Site that locks its dependencies with pnpm", async () => {
    site = await serveFixtureSite("clean");
    const { run, report } = await review(site.url, "pnpm-lockfile");

    expect(run.exitCode).toBe(0);
    expect(report.passed).toBe(true);
    const check = checkOf(report, "security/advisories");
    expect(check.failures).toEqual([]);
    expect(check.skipped).toMatch(/pnpm-lock\.yaml/);
    expect(check.skipped).not.toMatch(/switch|install the dependencies with npm/i);
  });

  it("leave out the checks that read the Site's repository when run outside one, and say so", async () => {
    site = await serveFixtureSite("clean");
    const { run, report } = await review(site.url, undefined);

    expect(run.exitCode).toBe(0);
    expect(report.passed).toBe(true);
    for (const id of ["security/advisories", "code/site-tests"]) {
      expect(checkOf(report, id).skipped).toMatch(/factory\.json|Site's folder/);
    }
    const text = await runFactory(["review", site.url, "--check", "code/site-tests"], { cwd: process.cwd() });
    expect(text.stdout).toMatch(/NOT RUN\s+The Site's own tests/);
    expect(text.stdout).toMatch(/not run/i);
  });
});

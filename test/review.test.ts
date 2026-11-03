import { afterEach, describe, expect, it } from "vitest";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";

const REVIEW_AREAS = ["Performance", "Accessibility", "Privacy & legal", "Visibility", "Code & security"];

interface JsonReport {
  url: string;
  routes: string[];
  passed: boolean;
  areas: {
    area: string;
    checks: { id: string; name: string; passed: boolean; failures: { reason: string; location: string }[] }[];
  }[];
}

let site: ServedSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

async function review(fixture: string, ...flags: string[]) {
  site = await serveFixtureSite(fixture);
  return runFactory(["review", site.url, ...flags], { cwd: process.cwd() });
}

function failingChecks(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks.filter((check) => !check.passed).map((check) => check.id));
}

describe("factory review <url>", () => {
  it("passes the clean fixture on every route", async () => {
    const run = await review("clean", "--json");
    const report = JSON.parse(run.stdout) as JsonReport;

    expect(run.exitCode).toBe(0);
    expect(report.passed).toBe(true);
    expect(failingChecks(report)).toEqual([]);
    expect(report.routes).toEqual(["/", "/about.html"]);
  });

  it("fails the low-contrast fixture on exactly the accessibility check", async () => {
    const run = await review("low-contrast", "--json");
    const report = JSON.parse(run.stdout) as JsonReport;

    expect(run.exitCode).toBe(1);
    expect(report.passed).toBe(false);
    expect(failingChecks(report)).toEqual(["accessibility/axe"]);
  });

  it("gives each failure a plain-language reason and where it failed", async () => {
    const run = await review("low-contrast", "--json");
    const report = JSON.parse(run.stdout) as JsonReport;
    const axe = report.areas.find((area) => area.area === "Accessibility")!.checks.find((c) => c.id === "accessibility/axe")!;

    expect(axe.failures).toHaveLength(1);
    const [failure] = axe.failures;
    expect(failure!.reason).toMatch(/text/i);
    expect(failure!.reason).toMatch(/contrast/i);
    expect(failure!.reason).toMatch(/4\.5:1/);
    expect(failure!.location).toMatch(/^\/about\.html /);
    expect(failure!.location).toMatch(/faint/);
  });

  it("groups its results by Review area", async () => {
    const run = await review("clean", "--json");
    const report = JSON.parse(run.stdout) as JsonReport;

    expect(report.areas.map((area) => area.area)).toEqual(REVIEW_AREAS);
    const accessibility = report.areas.find((area) => area.area === "Accessibility")!;
    expect(accessibility.checks.map((check) => check.id)).toContain("accessibility/axe");
  });

  it("prints the failing check under its Review area, with the reason and location", async () => {
    const run = await review("low-contrast");

    expect(run.exitCode).toBe(1);
    const lines = run.stdout.split("\n");
    const areaLines = lines.filter((line) => REVIEW_AREAS.includes(line.trim()));
    expect(areaLines.map((line) => line.trim())).toEqual(REVIEW_AREAS);

    const accessibilityAt = lines.findIndex((line) => line.trim() === "Accessibility");
    const nextAreaAt = lines.findIndex((line, i) => i > accessibilityAt && REVIEW_AREAS.includes(line.trim()));
    const section = lines.slice(accessibilityAt, nextAreaAt).join("\n");
    expect(section).toMatch(/FAIL/);
    expect(section).toMatch(/contrast/i);
    expect(section).toMatch(/\/about\.html/);
    expect(run.stdout).toMatch(/did not pass/i);
  });

  it("says the clean fixture Passes", async () => {
    const run = await review("clean");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/PASS\s+.*axe/i);
    expect(run.stdout).not.toMatch(/FAIL/);
    expect(run.stdout).toMatch(/Passes every Review check/);
  });

  it("explains a URL it cannot open", async () => {
    site = await serveFixtureSite("clean");
    const gone = new URL("/does-not-exist.html", site.url).href;
    const run = await runFactory(["review", gone], { cwd: process.cwd() });

    expect(run.exitCode).toBe(3);
    expect(run.stderr).toMatch(/404/);
    expect(run.stderr).toMatch(/does-not-exist\.html/);
  });

  it("refuses something that is not a web address", async () => {
    const run = await runFactory(["review", "my-site"], { cwd: process.cwd() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/http/);
  });
});

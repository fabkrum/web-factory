import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages } from "./harness/served-pages.ts";

interface JsonReport {
  passed: boolean;
  areas: { area: string; checks: { id: string; passed: boolean; failures: { reason: string; location: string }[] }[] }[];
}

let site: ServedSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

async function reviewJson(url: string, ...flags: string[]) {
  const run = await runFactory(["review", url, "--json", ...flags], { cwd: process.cwd() });
  return { run, report: JSON.parse(run.stdout) as JsonReport };
}

async function reviewFixture(fixture: string) {
  site = await serveFixtureSite(fixture);
  return reviewJson(site.url);
}

function failingChecks(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks.filter((check) => !check.passed).map((check) => check.id));
}

function lighthouse(report: JsonReport) {
  return report.areas.find((area) => area.area === "Performance")!.checks.find((check) => check.id === "performance/lighthouse")!;
}

describe("the Lighthouse Review check", () => {
  it("fails a page over the LCP budget with the measured value and the budget", async () => {
    const { run, report } = await reviewFixture("slow-lcp");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["performance/lighthouse"]);
    const [failure, ...others] = lighthouse(report).failures;
    expect(others).toEqual([]);
    expect(failure!.reason).toMatch(/largest contentful paint/i);
    const measured = Number(/after (\d+\.\d) s/.exec(failure!.reason)?.[1]);
    expect(measured).toBeGreaterThan(2.5);
    expect(failure!.reason).toMatch(/budget of 2\.5 s/);
    expect(failure!.location).toMatch(/^\/about\.html at .*img/);
  }, 180_000);

  it("fails a page whose layout shifts by more than 0.1", async () => {
    const { run, report } = await reviewFixture("layout-shift");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["performance/lighthouse"]);
    const [failure, ...others] = lighthouse(report).failures;
    expect(others).toEqual([]);
    expect(failure!.reason).toMatch(/layout shift/i);
    const measured = Number(/layout shift is (\d+(\.\d+)?)/.exec(failure!.reason)?.[1]);
    expect(measured).toBeGreaterThan(0.1);
    expect(failure!.reason).toMatch(/budget of 0\.1\b/);
    expect(failure!.location).toMatch(/^\/about\.html/);
  }, 180_000);

  it("passes a page whose layout shifts by 0.05, inside the budget rather than zero", async () => {
    const { run, report } = await reviewFixture("small-layout-shift");

    expect(failingChecks(report)).toEqual([]);
    expect(run.exitCode).toBe(0);
  }, 180_000);

  describe("takes the median of several runs", () => {
    /** A page whose hero picture is far too heavy on the first `heavyRuns` Lighthouse runs and light after. */
    async function serveNoisy(heavyRuns: number) {
      let lighthouseRuns = 0;
      site = await servePages({
        "/": `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Noisy</title></head>
<body><main><h1>Noisy</h1><img src="/hero.svg" width="400" height="300" alt="A red rectangle"></main></body></html>`,
        "/hero.svg": (request: IncomingMessage, response: ServerResponse) => {
          // Lighthouse loads the page as a phone; the review's own browser finding routes does not.
          const heavy = /Android/.test(request.headers["user-agent"] ?? "") && ++lighthouseRuns <= heavyRuns;
          const padding = heavy ? `<!-- ${"x".repeat(900 * 1024)} -->` : "";
          response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
          response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">${padding}<rect width="400" height="300" fill="#b3261e"/></svg>`);
        },
      });
      return reviewJson(site.url, "--check", "performance/lighthouse");
    }

    it("passes when only one of three runs is over the budget", async () => {
      const { run, report } = await serveNoisy(1);

      expect(lighthouse(report).failures).toEqual([]);
      expect(run.exitCode).toBe(0);
    }, 180_000);

    it("fails when two of three runs are over the budget, naming the median and every run", async () => {
      const { run, report } = await serveNoisy(2);

      expect(run.exitCode).toBe(1);
      const [failure] = lighthouse(report).failures;
      expect(failure!.reason).toMatch(/median of 3 Lighthouse runs/);
      const runs = /runs: ([^)]*)\)/.exec(failure!.reason)![1]!.split(", ").map((value) => Number.parseFloat(value));
      expect(runs).toHaveLength(3);
      expect(runs.filter((value) => value > 2.5)).toHaveLength(2);
      const median = Number(/after (\d+\.\d) s/.exec(failure!.reason)?.[1]);
      expect(median).toBe([...runs].sort((a, b) => a - b)[1]);
    }, 180_000);
  });

  it("refuses a Review check it does not have", async () => {
    const run = await runFactory(["review", "http://127.0.0.1:9/", "--check", "performance/nope"], { cwd: process.cwd() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/performance\/nope/);
  });
});

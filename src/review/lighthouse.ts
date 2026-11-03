import { existsSync } from "node:fs";
import { launch, type LaunchedChrome } from "chrome-launcher";
import lighthouse, { type Result } from "lighthouse";
import { chromium } from "playwright";
import { ReviewError, type Failure, type ReviewCheck, type Route } from "./check.ts";

/**
 * How many times Lighthouse measures each route. The median of three keeps one
 * noisy run from passing or failing a Site; Lighthouse's own advice of five
 * would make every review of a small Site take minutes.
 */
export const LIGHTHOUSE_RUNS = 3;

/** One fixed budget, in the units the Builder reads it in. */
interface Budget {
  audit: string;
  /** What is compared with the limit: the median, rounded the way it is shown. */
  shown: (value: number) => number;
  format: (value: number) => string;
  limit: number;
  /** The audit that names the element to blame, if Lighthouse has one. */
  elementAudit?: string;
  reason: (median: string, limit: string, runs: string) => string;
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;
const twoDecimals = (value: number) => Math.round(value * 100) / 100;
const tensOfMs = (ms: number) => Math.round(ms / 10) * 10;

/**
 * The Core Web Vitals "good" thresholds, measured as Lighthouse does on a
 * mid-range phone over a slow connection. Total blocking time stands in for
 * INP, which a lab run cannot measure without a Visitor. CLS is held to 0.1,
 * not zero: a page that never moves at all is not what Visitors need, and zero
 * would fail Sites over shifts nobody sees.
 */
const BUDGETS: Budget[] = [
  {
    audit: "largest-contentful-paint",
    shown: seconds,
    format: (value) => `${value.toFixed(1)} s`,
    limit: 2.5,
    elementAudit: "lcp-breakdown-insight",
    reason: (median, limit, runs) =>
      `The largest thing on this page (its main picture or headline) appears after ${median} on a mid-range phone, over the budget of ${limit} (largest contentful paint, median of ${runs}). Visitors stare at an unfinished page until then. Make it lighter or load it sooner: compress or resize the image, and do not hide it behind scripts or late styles.`,
  },
  {
    audit: "cumulative-layout-shift",
    shown: twoDecimals,
    format: (value) => String(value),
    limit: 0.1,
    elementAudit: "layout-shifts",
    reason: (median, limit, runs) =>
      `Content on this page jumps while it loads: its layout shift is ${median}, over the budget of ${limit} (cumulative layout shift, median of ${runs}). Visitors lose their place or tap the wrong thing. Reserve the space for anything that arrives late: width and height on images, a fixed height for banners and embeds.`,
  },
  {
    audit: "total-blocking-time",
    shown: tensOfMs,
    format: (value) => `${value} ms`,
    limit: 200,
    reason: (median, limit, runs) =>
      `This page keeps the phone busy running scripts for ${median} while it loads, over the budget of ${limit} (total blocking time, median of ${runs}), so taps and clicks answer late. Run less JavaScript when the page loads, or split long tasks up.`,
  },
];

export const lighthouseCheck: ReviewCheck = {
  id: "performance/lighthouse",
  name: `Lighthouse budgets, median of ${LIGHTHOUSE_RUNS} runs`,
  area: "Performance",
  async run(site) {
    const failures: Failure[] = [];
    const chrome = await launchChrome();
    try {
      for (const route of site.routes) {
        if (route.problem) {
          failures.push({ reason: route.problem, location: route.path });
          continue;
        }
        failures.push(...(await measure(chrome, route)));
      }
    } finally {
      await chrome.kill();
    }
    return failures;
  },
};

/**
 * Lighthouse drives Chrome over a debugging port, which the review's own
 * Playwright browser does not open, so it gets a headless Chrome of its own:
 * Playwright's Chromium when it is installed, otherwise the Google Chrome
 * already on the machine.
 */
async function launchChrome(): Promise<LaunchedChrome> {
  const playwrights = chromium.executablePath();
  try {
    return await launch({
      chromePath: existsSync(playwrights) ? playwrights : undefined,
      chromeFlags: ["--headless=new", "--no-first-run"],
    });
  } catch {
    throw new ReviewError(
      "The review measures your Site's speed with Lighthouse in a browser and found none on this machine. Install one with this command, then run the review again:\n  npx playwright install chromium",
    );
  }
}

/** Runs Lighthouse on one route several times and holds the median of each measurement to its budget. */
async function measure(chrome: LaunchedChrome, route: Route): Promise<Failure[]> {
  const runs: Result[] = [];
  const errors: string[] = [];
  for (let run = 0; run < LIGHTHOUSE_RUNS; run++) {
    const result = await lighthouse(route.address.href, {
      port: chrome.port,
      logLevel: "error",
      onlyAudits: BUDGETS.flatMap((budget) => [budget.audit, ...(budget.elementAudit ? [budget.elementAudit] : [])]),
    });
    const lhr = result?.lhr;
    if (lhr?.runtimeError) errors.push(lhr.runtimeError.message);
    else if (lhr) runs.push(lhr);
  }
  if (runs.length === 0) {
    return [
      {
        reason: `Lighthouse could not measure this page's speed (${errors[0] ?? "it returned no result"}). Check that it loads and shows something in a browser.`,
        location: route.path,
      },
    ];
  }
  return BUDGETS.flatMap((budget) => {
    const measured = runs
      .map((lhr) => ({ lhr, value: lhr.audits[budget.audit]?.numericValue }))
      .filter((run): run is { lhr: Result; value: number } => typeof run.value === "number")
      .sort((a, b) => a.value - b.value);
    if (measured.length === 0) return [];
    const middle = measured[Math.floor((measured.length - 1) / 2)]!;
    const median = budget.shown(medianOf(measured.map((run) => run.value)));
    if (median <= budget.limit) return [];
    const each = runs
      .map((lhr) => lhr.audits[budget.audit]?.numericValue)
      .filter((value): value is number => typeof value === "number")
      .map((value) => budget.format(budget.shown(value)));
    const runsText = `${measured.length} Lighthouse ${measured.length === 1 ? "run" : "runs"}: ${each.join(", ")}`;
    return [
      {
        reason: budget.reason(budget.format(median), budget.format(budget.limit), runsText),
        location: locate(route.path, budget.elementAudit ? middle.lhr.audits[budget.elementAudit] : undefined),
      },
    ];
  });
}

function medianOf(sorted: number[]): number {
  const half = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(half)]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

/** The route, and the element Lighthouse blames, so the Builder can find it in their own code. */
function locate(route: string, audit: Result["audits"][string] | undefined): string {
  const node = firstNode(audit?.details);
  if (!node) return route;
  const tag = node.snippet ?? "";
  return `${route} at ${node.selector ?? ""}${tag ? `: ${tag.length > 100 ? `${tag.slice(0, 99)}…` : tag}` : ""}`;
}

/** The first page element named in an audit's details: an item that is a node, has one, or nests a table that does. */
function firstNode(details: unknown): { selector?: string; snippet?: string } | undefined {
  const items = (details as { items?: unknown[] } | undefined)?.items ?? [];
  for (const item of items) {
    const node = (item as { type?: string; node?: { type?: string } }).type === "node" ? item : (item as { node?: unknown }).node;
    if ((node as { type?: string } | undefined)?.type === "node") return node as { selector?: string; snippet?: string };
    const nested = firstNode(item);
    if (nested) return nested;
  }
  return undefined;
}

/** The audits Measure reads on the live Site, by the name it records them under. */
const LIVE_AUDITS = { lcp: "largest-contentful-paint", cls: "cumulative-layout-shift", tbt: "total-blocking-time" } as const;

/**
 * Lighthouse on the live Site after a Publish: the median of each measurement over
 * LIGHTHOUSE_RUNS runs of the one address. Unlike the Review check it holds nothing to a
 * budget: Measure compares it with the previous measurement.
 */
export async function measureLive(url: URL): Promise<Partial<Record<keyof typeof LIVE_AUDITS, number>>> {
  const chrome = await launchChrome();
  try {
    const runs: Result[] = [];
    const errors: string[] = [];
    for (let run = 0; run < LIGHTHOUSE_RUNS; run++) {
      const lhr = (await lighthouse(url.href, { port: chrome.port, logLevel: "error", onlyAudits: Object.values(LIVE_AUDITS) }))?.lhr;
      if (lhr?.runtimeError) errors.push(lhr.runtimeError.message);
      else if (lhr) runs.push(lhr);
    }
    if (runs.length === 0) throw new ReviewError(`Lighthouse could not measure the live Site at ${url.href} (${errors[0] ?? "it returned no result"}).`);
    const medians: Partial<Record<keyof typeof LIVE_AUDITS, number>> = {};
    for (const [name, audit] of Object.entries(LIVE_AUDITS) as [keyof typeof LIVE_AUDITS, string][]) {
      const values = runs.map((lhr) => lhr.audits[audit]?.numericValue).filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
      if (values.length > 0) medians[name] = medianOf(values);
    }
    return medians;
  } finally {
    await chrome.kill();
  }
}

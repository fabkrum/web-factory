import { axeCheck } from "./axe.ts";
import { launchBrowser } from "./browser.ts";
import { REVIEW_AREAS, type Failure, type ReviewArea, type ReviewCheck } from "./check.ts";
import { findRoutes } from "./routes.ts";

/** Every Review check `factory review` runs. */
export const REVIEW_CHECKS: ReviewCheck[] = [axeCheck];

export interface CheckResult {
  id: string;
  name: string;
  passed: boolean;
  failures: Failure[];
}

export interface ReviewReport {
  url: string;
  routes: string[];
  /** True when every Review check passed: the Site Passes. */
  passed: boolean;
  /** All five Review areas in order, each with its checks; an area may have none yet. */
  areas: { area: ReviewArea; checks: CheckResult[] }[];
}

/** Measures the Site served at `url` with every Review check, on every route it can find. */
export async function runReview(url: URL, checks: ReviewCheck[] = REVIEW_CHECKS): Promise<ReviewReport> {
  const browser = await launchBrowser();
  try {
    const routes = await findRoutes(browser, url);
    const site = { url, routes, browser };
    const results = new Map<ReviewCheck, CheckResult>();
    for (const check of checks) {
      const failures = await check.run(site);
      results.set(check, { id: check.id, name: check.name, passed: failures.length === 0, failures });
    }
    const areas = REVIEW_AREAS.map((area) => ({
      area,
      checks: checks.filter((check) => check.area === area).map((check) => results.get(check)!),
    }));
    return { url: url.href, routes, passed: [...results.values()].every((result) => result.passed), areas };
  } finally {
    await browser.close();
  }
}

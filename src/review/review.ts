import { axeCheck } from "./axe.ts";
import { launchBrowser } from "./browser.ts";
import { REVIEW_AREAS, type Failure, type ReviewArea, type ReviewCheck } from "./check.ts";
import { lighthouseCheck } from "./lighthouse.ts";
import { oneUrlCheck } from "./one-url.ts";
import { findRoutes } from "./routes.ts";
import { sitemapCheck } from "./sitemap.ts";
import { canonicalCheck, socialPreviewCheck, structuredDataCheck } from "./visibility.ts";

/** Every Review check `factory review` runs. */
export const REVIEW_CHECKS: ReviewCheck[] = [
  lighthouseCheck,
  axeCheck,
  sitemapCheck,
  canonicalCheck,
  oneUrlCheck,
  socialPreviewCheck,
  structuredDataCheck,
];

export interface CheckResult {
  id: string;
  name: string;
  passed: boolean;
  failures: Failure[];
}

export interface ReviewReport {
  /** The address the Site answered at after any redirect. */
  url: string;
  /** Every route checked, e.g. "/" or "/about.html". */
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
    const { url: siteUrl, routes } = await findRoutes(browser, url);
    const site = { url: siteUrl, routes, browser };
    const results = new Map<ReviewCheck, CheckResult>();
    for (const check of checks) {
      const failures = await check.run(site);
      results.set(check, { id: check.id, name: check.name, passed: failures.length === 0, failures });
    }
    const areas = REVIEW_AREAS.map((area) => ({
      area,
      checks: checks.filter((check) => check.area === area).map((check) => results.get(check)!),
    }));
    return { url: siteUrl.href, routes: routes.map((route) => route.path), passed: [...results.values()].every((result) => result.passed), areas };
  } finally {
    await browser.close();
  }
}

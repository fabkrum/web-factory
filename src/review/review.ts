import type { LocalePack } from "../config.ts";
import { axeCheck } from "./axe.ts";
import { launchBrowser } from "./browser.ts";
import { designCheck } from "./design.ts";
import { REVIEW_AREAS, type Failure, type ReviewArea, type ReviewCheck } from "./check.ts";
import { GERMAN_LOCALE_PACK } from "./german-locale-pack.ts";
import { lighthouseCheck } from "./lighthouse.ts";
import { oneUrlCheck } from "./one-url.ts";
import { findRoutes } from "./routes.ts";
import { sitemapCheck } from "./sitemap.ts";
import { advisoriesCheck, siteTestsCheck } from "./repository.ts";
import { consoleCheck, headersCheck } from "./security.ts";
import { canonicalCheck, socialPreviewCheck, structuredDataCheck } from "./visibility.ts";

/** Every Review check `factory review` has; a Locale pack's run only on a Site with that pack on. */
export const REVIEW_CHECKS: ReviewCheck[] = [
  lighthouseCheck,
  axeCheck,
  ...GERMAN_LOCALE_PACK,
  sitemapCheck,
  canonicalCheck,
  oneUrlCheck,
  socialPreviewCheck,
  structuredDataCheck,
  headersCheck,
  consoleCheck,
  advisoriesCheck,
  siteTestsCheck,
  designCheck,
];

/** Why a check that reads the Site's repository did not run, when the review runs outside one. */
export const NO_REPO =
  "Not run: this check reads your Site's repository, and the review was not started from a folder with a factory.json. Run factory review from your Site's folder to include it.";

/** Shown in the Privacy & legal area when the Site has no Locale pack on. */
const NO_PACK_NOTE =
  "No Locale pack is on, so the review checked no country's law. This is not legal advice: what the law asks of your Site is yours to find out.";

/** Shown in the Privacy & legal area when the German Locale pack is on, where a pass carries no reason to say it. */
const GERMAN_PACK_NOTE =
  "The German Locale pack is on. It catches common mistakes, and passing it does not make a Site lawful. This is not legal advice.";

export interface CheckResult {
  id: string;
  name: string;
  passed: boolean;
  failures: Failure[];
  /** Why the check did not run; a check that did not run has no failures and does not stop a Pass. */
  skipped?: string;
}

export interface ReviewReport {
  /** The address the Site answered at after any redirect. */
  url: string;
  /** Every route checked, e.g. "/" or "/about.html". */
  routes: string[];
  /** True when every Review check passed: the Site Passes. */
  passed: boolean;
  /** All five Review areas in order, each with its checks; an area may have none yet. */
  areas: { area: ReviewArea; checks: CheckResult[]; note?: string }[];
}

/**
 * Measures the Site served at `url` with every Review check, on every route it
 * can find. `repo` is the Site's repository folder; without one, the checks that
 * read it are reported as not run. A check of a Locale pack other than
 * `localePack` is left out altogether.
 */
export async function runReview(url: URL, requested: ReviewCheck[] = REVIEW_CHECKS, repo?: string, localePack?: LocalePack): Promise<ReviewReport> {
  const checks = requested.filter((check) => !check.localePack || check.localePack === localePack);
  const browser = await launchBrowser();
  try {
    const { url: siteUrl, routes } = await findRoutes(browser, url);
    const site = { url: siteUrl, routes, browser, repo };
    const results = new Map<ReviewCheck, CheckResult>();
    for (const check of checks) {
      if (check.needsRepo && !repo) {
        results.set(check, { id: check.id, name: check.name, passed: true, failures: [], skipped: NO_REPO });
        continue;
      }
      const outcome = await check.run(site);
      if ("notRun" in outcome) {
        results.set(check, { id: check.id, name: check.name, passed: true, failures: [], skipped: outcome.notRun });
        continue;
      }
      const failures = outcome;
      results.set(check, { id: check.id, name: check.name, passed: failures.length === 0, failures });
    }
    const areas = REVIEW_AREAS.map((area) => ({
      area,
      checks: checks.filter((check) => check.area === area).map((check) => results.get(check)!),
      ...(area === "Privacy & legal" ? { note: localePack ? GERMAN_PACK_NOTE : NO_PACK_NOTE } : {}),
    }));
    return { url: siteUrl.href, routes: routes.map((route) => route.path), passed: [...results.values()].every((result) => result.passed), areas };
  } finally {
    await browser.close();
  }
}

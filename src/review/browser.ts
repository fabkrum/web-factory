import { chromium, type Browser, type Page, type Response } from "playwright";
import { ReviewError } from "./check.ts";

/** One page could not be checked: the reason, in plain language, is that page's failure; the review goes on. */
export class PageError extends Error {}

/**
 * Starts a headless browser: Playwright's own Chromium when it is installed,
 * otherwise the Google Chrome already on the machine.
 */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw new ReviewError(
        "The review opens your Site in a browser and found none on this machine. Install one with this command, then run the review again:\n  npx playwright install chromium",
      );
    }
  }
}

/**
 * A fresh page to review the Site in. The Site's Content-Security-Policy is
 * bypassed, so the review can inject its tools into a Site that forbids inline
 * scripts. Close it with `page.context().close()`.
 */
export async function openReviewPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ bypassCSP: true });
  return context.newPage();
}

/** How long the review waits for one page to load before it reports that page as failed. */
const LOAD_TIMEOUT = 15_000;

/**
 * Opens one address in the review page. A navigation that fails (a redirect
 * loop, a refused connection, a page that never loads) is a PageError for that
 * page alone.
 */
export async function goTo(page: Page, url: URL): Promise<Response | null> {
  try {
    return await page.goto(url.href, { waitUntil: "load", timeout: LOAD_TIMEOUT });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ERR_TOO_MANY_REDIRECTS/.test(message)) {
      throw new PageError("This page redirects in a loop or through too many steps, so a browser never arrives at it. Point its redirect straight at the page it should show.");
    }
    if (/Timeout/i.test(message)) {
      throw new PageError(
        `This page did not finish loading within ${LOAD_TIMEOUT / 1000} seconds, or reloads itself before it does, so the review could not check it. Check that it loads once in a browser.`,
      );
    }
    const detail = /net::[A-Z_]+/.exec(message)?.[0] ?? message.split("\n")[0];
    throw new PageError(`The review could not open this page (${detail}). Check that your Site serves it, then run the review again.`);
  }
}

/** A clean review page in place of one a failed page left behind, still moving or broken. */
export async function reopen(page: Page): Promise<Page> {
  const browser = page.context().browser()!;
  await page.context().close();
  return openReviewPage(browser);
}

/** How long the review waits for a page that sends the browser on to move. */
const LANDING_TIMEOUT = 5_000;

/** How many times a page may send the browser on before the review gives up on it. */
const MAX_HOPS = 5;

/**
 * Reads the page the browser settled on. A page can send the browser on by
 * itself after it loaded, as an alias page with `<meta http-equiv="refresh"
 * content="0;url=…">` does; the review waits for the page it lands on and
 * reads that, and reads again if it moved on while being read. A page still
 * moving after a few hops (a chain of refreshes, a script that reloads it) is
 * a PageError.
 */
export async function settled<T>(page: Page, read: () => Promise<T>): Promise<T> {
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    try {
      await page.waitForLoadState("load");
      const moving = movesOn(page);
      if (!(await refreshesAtOnce(page)) || !(await moving)) return await read();
    } catch (error) {
      if (!movedOn(error)) throw error;
    }
  }
  throw new PageError(
    "This page keeps sending the browser on to another page or reloads itself (a chain of meta refreshes or a script), so it never holds still long enough to be checked. Link straight to the page it should show.",
  );
}

/** The error Playwright throws when the page navigated away while the review was reading it. */
function movedOn(error: unknown): boolean {
  return error instanceof Error && /context was destroyed|navigat/i.test(error.message);
}

/** Whether the page carries a meta refresh that fires at once. */
function refreshesAtOnce(page: Page): Promise<boolean> {
  return page.$$eval('meta[http-equiv="refresh" i]', (metas) =>
    metas.some((meta) => /^\s*0*(\.0*)?\s*([;,]|$)/.test(meta.getAttribute("content") ?? "")),
  );
}

/** Waits for the page to navigate, to itself or elsewhere; false when it stays put. */
async function movesOn(page: Page): Promise<boolean> {
  return page
    .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: LANDING_TIMEOUT })
    .then(() => true, () => false);
}

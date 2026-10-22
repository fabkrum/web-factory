import { chromium, type Browser, type Page } from "playwright";
import { ReviewError } from "./check.ts";

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

/** How long the review waits for a page that sends the browser on to land. */
const LANDING_TIMEOUT = 5_000;

/**
 * Reads the page the browser settled on. A page can send the browser on by
 * itself after it loaded, as an alias page with `<meta http-equiv="refresh"
 * content="0;url=…">` does; the review waits for the page it lands on and
 * reads that, and reads it again once if it moved on while being read.
 */
export async function settled<T>(page: Page, read: () => Promise<T>): Promise<T> {
  await landed(page);
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Error && /context was destroyed|navigat/i.test(error.message))) throw error;
    await page.waitForLoadState("load");
    await landed(page);
    return read();
  }
}

/** Waits for an immediate meta refresh to take the browser to its next page. */
async function landed(page: Page): Promise<void> {
  const from = page.url();
  const refreshes = await page
    .$$eval('meta[http-equiv="refresh" i]', (metas) => metas.some((meta) => /^\s*0*(\.0*)?\s*([;,]|$)/.test(meta.getAttribute("content") ?? "")))
    .catch(() => true);
  if (!refreshes) return;
  await page.waitForURL((url) => url.href !== from, { waitUntil: "load", timeout: LANDING_TIMEOUT }).catch(() => undefined);
}

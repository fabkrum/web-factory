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

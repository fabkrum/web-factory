import { chromium, type Browser } from "playwright";
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

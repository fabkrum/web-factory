import type { Browser, Page } from "playwright";
import { goTo, PageError, settled } from "./browser.ts";
import type { Failure, ReviewCheck, Route } from "./check.ts";
import { fetchFromSite } from "./fetch.ts";

/** What the security headers check reads of one page's answer. */
interface Answer {
  headers: Headers;
  /** Every Content-Security-Policy a <meta http-equiv> in the page sets. */
  metaPolicies: string[];
  https: boolean;
}

/** One protection a page's answer must carry: whether it does, and what is missing in words the Builder can act on. */
interface Protection {
  missing(answer: Answer): string | undefined;
}

const HEADERS: Protection[] = [
  {
    missing({ headers, metaPolicies }) {
      if (headers.get("content-security-policy")?.trim() || metaPolicies.some((policy) => policy.trim())) return undefined;
      const reportOnly = headers.get("content-security-policy-report-only")?.trim()
        ? " It has only Content-Security-Policy-Report-Only, which reports what it would block and enforces nothing."
        : "";
      return `Content-Security-Policy, which tells the browser where scripts, styles and images may come from, so a script someone smuggles into the page cannot run.${reportOnly}`;
    },
  },
  {
    missing: ({ headers }) =>
      headers.get("x-content-type-options")?.trim().toLowerCase() === "nosniff"
        ? undefined
        : 'X-Content-Type-Options: nosniff, which stops the browser from guessing a file\'s type and running an uploaded text file as a script.',
  },
  {
    missing({ headers }) {
      const frameOptions = headers.get("x-frame-options")?.trim().toUpperCase();
      // frame-ancestors only counts in the header: browsers ignore it in a <meta> policy.
      const ancestors = /(^|;)\s*frame-ancestors\s/i.test(headers.get("content-security-policy") ?? "");
      return frameOptions === "DENY" || frameOptions === "SAMEORIGIN" || ancestors
        ? undefined
        : "X-Frame-Options: DENY (or frame-ancestors in the Content-Security-Policy header), which stops another site from showing this page inside a frame to trick Visitors into clicking on it.";
    },
  },
  {
    missing: ({ headers, https }) =>
      !https || headers.get("strict-transport-security")?.trim()
        ? undefined
        : "Strict-Transport-Security, which tells browsers to always open this Site over https, so nobody on the Visitor's network can read or change it.",
  },
];

export const headersCheck: ReviewCheck = {
  id: "security/headers",
  name: "Security headers on every route",
  area: "Code & security",
  async run(site) {
    const failures: Failure[] = [];
    for (const route of site.routes) {
      if (route.problem) {
        failures.push({ reason: route.problem, location: route.path });
        continue;
      }
      const answer = await fetchFromSite(route.address);
      if (!answer) {
        failures.push({ reason: "The review could not ask the Site for this page, so it could not read its headers. Check that your Site serves it, then run the review again.", location: route.path });
        continue;
      }
      const missing = HEADERS.map((protection) =>
        protection.missing({
          headers: answer.headers,
          metaPolicies: metaPolicies(answer.body),
          https: answer.url.protocol === "https:" && !isLocal(answer.url),
        }),
      ).filter((text) => text !== undefined);
      if (missing.length === 0) continue;
      failures.push({
        reason: `This page is served without ${missing.length === 1 ? "a security header" : `${missing.length} security headers`} every page needs: ${missing.join(" ")} Your host sets headers in its configuration (on Firebase Hosting, the "headers" section of firebase.json).`,
        location: route.path,
      });
    }
    return failures;
  },
};

/** The content of every <meta http-equiv="Content-Security-Policy"> in an HTML page. */
function metaPolicies(html: string): string[] {
  return [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => /http-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(tag))
    .map((tag) => /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag))
    .map((content) => content?.[1] ?? content?.[2] ?? "");
}

/** A Site on this machine is reviewed over plain http, where Strict-Transport-Security means nothing. */
function isLocal(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
}

/** How long the console check keeps listening after a page settled, for errors a script logs a moment after load. */
const LISTEN_AFTER_LOAD = 1_000;

export const consoleCheck: ReviewCheck = {
  id: "code/console",
  name: "Console free of errors on every route",
  area: "Code & security",
  async run(site) {
    const failures: Failure[] = [];
    for (const route of site.routes) {
      if (route.problem) {
        failures.push({ reason: route.problem, location: route.path });
        continue;
      }
      failures.push(...(await consoleErrorsOn(site.browser, route, site.url)));
    }
    return failures;
  },
};

/** One error the browser's console showed on a page. */
interface ConsoleError {
  message: string;
  /** The script or file it came from, and its line when the browser says. */
  source?: string;
}

/**
 * Opens one route the way a Visitor's browser does, with the Site's own
 * Content-Security-Policy in force (the other checks bypass it to inject their
 * tools), so a script the policy blocks counts too.
 */
async function consoleErrorsOn(browser: Browser, route: Route, siteUrl: URL): Promise<Failure[]> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = listen(page, siteUrl);
    try {
      await goTo(page, route.address);
      await settled(page, () => page.waitForTimeout(LISTEN_AFTER_LOAD));
    } catch (error) {
      if (!(error instanceof PageError)) throw error;
      return [{ reason: error.message, location: route.path }];
    }
    const seen = new Set<string>();
    return errors
      .filter((error) => !seen.has(error.message + error.source) && seen.add(error.message + error.source))
      .map((error) => ({
        reason: `The browser console shows an error on this page: "${error.message}". Something on the page is broken for Visitors; open the page with the browser's developer tools (F12, then Console) to see it, and fix what it names.`,
        location: error.source ? `${route.path} from ${error.source}` : route.path,
      }));
  } finally {
    await context.close();
  }
}

/** Collects every console error and uncaught exception the page shows from now on. */
function listen(page: Page, siteUrl: URL): ConsoleError[] {
  const errors: ConsoleError[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const { url, lineNumber } = message.location();
    const text = message.text();
    // Chrome names no file in a failed load's message: its location is the file that failed.
    if (/^Failed to load resource/.test(text) && url) return errors.push({ message: `${text}: ${shown(url, siteUrl)}` });
    errors.push({ message: text, source: url ? `${shown(url, siteUrl)}${lineNumber > 0 ? ` line ${lineNumber + 1}` : ""}` : undefined });
  });
  page.on("pageerror", (error) => errors.push({ message: `Uncaught ${error.name}: ${error.message}` }));
  return errors;
}

/** An address on the Site as its path, any other in full. */
function shown(address: string, siteUrl: URL): string {
  try {
    const url = new URL(address);
    return url.origin === siteUrl.origin ? `${url.pathname}${url.search}` : url.href;
  } catch {
    return address;
  }
}

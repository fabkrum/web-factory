import type { Browser, Page } from "playwright";
import { ReviewError } from "./check.ts";

/** Stops a Site with endless generated links from making the review endless too. */
const MAX_ROUTES = 50;

/** Links to files with these endings are pages; links to any other file (a PDF, an image) are not. */
const PAGE_ENDINGS = new Set(["", ".html", ".htm", ".php"]);

/**
 * Finds every route of the Site by following its own links from the address the
 * Builder gave, the way a Visitor clicking through would. Only pages on the same
 * origin count; a link that does not answer with a page is left to other checks.
 */
export async function findRoutes(browser: Browser, start: URL): Promise<string[]> {
  const page = await browser.newPage();
  try {
    const routes: string[] = [];
    const queue = [routeOf(start)];
    const seen = new Set(queue);
    let isStart = true;
    while (queue.length > 0 && routes.length < MAX_ROUTES) {
      const route = queue.shift()!;
      const links = await visit(page, new URL(route, start), isStart);
      isStart = false;
      if (links === undefined) continue;
      routes.push(route);
      for (const link of links) {
        const url = new URL(link);
        if (url.origin !== start.origin || !isPage(url)) continue;
        const next = routeOf(url);
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return routes;
  } finally {
    await page.close();
  }
}

/** Opens one route and returns the links on it, or undefined when it is not a page. */
async function visit(page: Page, url: URL, isStart: boolean): Promise<string[] | undefined> {
  let response;
  try {
    response = await page.goto(url.href, { waitUntil: "load" });
  } catch {
    if (isStart) {
      throw new ReviewError(`The review could not reach ${url.href}. Check that your Site is being served and that the address is right.`);
    }
    return undefined;
  }
  const status = response?.status() ?? 0;
  if (status >= 400) {
    if (isStart) {
      throw new ReviewError(`The review could not open ${url.href}: the server answered ${status} instead of a page. Check the address.`);
    }
    return undefined;
  }
  if (!(response?.headers()["content-type"] ?? "text/html").includes("html")) return undefined;
  return page.$$eval("a[href]", (anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
}

function routeOf(url: URL): string {
  return url.pathname + url.search;
}

function isPage(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const last = url.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return PAGE_ENDINGS.has(dot === -1 ? "" : last.slice(dot).toLowerCase());
}

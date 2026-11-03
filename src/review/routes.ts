import type { Browser, Page } from "playwright";
import { goTo, openReviewPage, PageError, reopen, settled } from "./browser.ts";
import { ReviewError, type Route } from "./check.ts";

/** Stops a Site with endless generated links from making the review endless too. */
const MAX_ROUTES = 50;

/** Where the Site answered after any redirect, and every route on it. */
export interface SiteRoutes {
  url: URL;
  routes: Route[];
}

/**
 * A page that opened, at the address it ended up on; a link that is not a page
 * (an error status, another content type); or a page that failed to open.
 */
type Visit = { url: URL; links: string[] } | { notAPage: string } | { failed: string };

/**
 * Finds every route of the Site by following its own links from the address the
 * Builder gave, the way a Visitor clicking through would. The Site is the origin
 * that address ends up on after redirects. Links to that origin or to the start
 * address's own origin are followed; a route is kept only if it ends up on the
 * Site. A link that does not answer with a page is left to other checks; a page
 * that fails to open is kept unless another form of its route opens, so the
 * checks report its failure.
 */
export async function findRoutes(browser: Browser, start: URL): Promise<SiteRoutes> {
  let page = await openReviewPage(browser);
  try {
    const home = await visit(page, start);
    if ("notAPage" in home) throw new ReviewError(home.notAPage);
    if ("failed" in home) throw new ReviewError(`The review could not open ${start.href}: ${home.failed}`);
    const origin = home.url.origin;
    const followed = new Set([start.origin, origin]);
    const routes: Route[] = [];
    const found = new Set<string>();
    const requested = new Set([address(start), address(home.url)]);
    const queue: URL[] = [];
    /** Pages that failed to open, by route; kept only if no other form of their route opens. */
    const failed = new Map<string, Route>();
    const take = (url: URL, links: string[]) => {
      const path = routeOf(url);
      if (url.origin !== origin || found.has(path)) return;
      found.add(path);
      routes.push({ path, address: url });
      for (const link of links) {
        const next = parse(link);
        if (!next || !followed.has(next.origin) || requested.has(address(next))) continue;
        requested.add(address(next));
        queue.push(next);
      }
    };
    take(home.url, home.links);
    while (queue.length > 0 && routes.length < MAX_ROUTES) {
      const next = queue.shift()!;
      const visited = await visit(page, next);
      if ("url" in visited) take(visited.url, visited.links);
      if ("failed" in visited) {
        const path = routeOf(next);
        if (next.origin === origin && !failed.has(path)) failed.set(path, { path, address: next, problem: visited.failed });
        page = await reopen(page);
      }
    }
    for (const route of failed.values()) {
      if (routes.length < MAX_ROUTES && !found.has(route.path)) routes.push(route);
    }
    return { url: home.url, routes };
  } finally {
    await page.context().close();
  }
}

/** Opens one address and returns where it ended up and its links, or why it is not a page. */
async function visit(page: Page, url: URL): Promise<Visit> {
  try {
    const response = await goTo(page, url);
    const status = response?.status() ?? 0;
    if (status >= 400) {
      return { notAPage: `The review could not open ${url.href}: the server answered ${status} instead of a page. Check the address.` };
    }
    const type = response?.headers()["content-type"] ?? "text/html";
    if (!type.includes("html")) {
      return {
        notAPage: `The review could not open ${url.href} as a page: the server answered with ${type.split(";")[0]} instead of HTML. Give the address of your Site's home page.`,
      };
    }
    return await settled(page, async () => ({
      url: new URL(page.url()),
      links: await page.$$eval("a[href]", (anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href)),
    }));
  } catch (error) {
    if (error instanceof PageError) return { failed: error.message };
    throw error;
  }
}

/** A web link, or undefined for one the browser could not resolve or that is not http(s); broken links are another check's job. */
function parse(link: string): URL | undefined {
  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The exact address a link asks for; only the fragment, which never reaches the server, is left out. */
function address(url: URL): string {
  return url.href.replace(/#.*$/, "");
}

/**
 * The route a URL belongs to: its path without query string and without a
 * trailing slash, the root staying "/". Pages that differ only in their query
 * string are one route, reviewed at the first address that opened.
 */
export function routeOf(url: URL): string {
  return url.pathname.replace(/\/+$/, "") || "/";
}

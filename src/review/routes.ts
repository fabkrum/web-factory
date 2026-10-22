import { createHash } from "node:crypto";
import type { Browser, Page } from "playwright";
import { openReviewPage, settled } from "./browser.ts";
import { ReviewError } from "./check.ts";

/** Stops a Site with endless generated links from making the review endless too. */
const MAX_ROUTES = 50;

/** Where the Site answered after any redirect, and every route on it. */
export interface SiteRoutes {
  url: URL;
  routes: string[];
}

/** A page that opened, at the address it ended up on, or why it did not open as a page. */
type Visit = { url: URL; links: string[]; html: string } | { problem: string };

/**
 * Finds every route of the Site by following its own links from the address the
 * Builder gave, the way a Visitor clicking through would. The Site is the origin
 * that address ends up on after redirects. Links to that origin or to the start
 * address's own origin are followed; a route is kept only if it ends up on the
 * Site, and a link that does not answer with a page is left to other checks.
 */
export async function findRoutes(browser: Browser, start: URL): Promise<SiteRoutes> {
  const page = await openReviewPage(browser);
  try {
    const home = await visit(page, start);
    if ("problem" in home) throw new ReviewError(home.problem);
    const origin = home.url.origin;
    const followed = new Set([start.origin, origin]);
    const routes: string[] = [];
    const found = new Set<string>();
    const requested = new Set([address(start), address(home.url)]);
    const queue: URL[] = [];
    const take = (visited: { url: URL; links: string[]; html: string }) => {
      const key = documentKey(visited.url, visited.html);
      if (visited.url.origin !== origin || found.has(key)) return;
      found.add(key);
      routes.push(visited.url.pathname + visited.url.search);
      for (const link of visited.links) {
        const url = parse(link);
        if (!url || !followed.has(url.origin)) continue;
        const next = address(url);
        if (requested.has(next)) continue;
        requested.add(next);
        queue.push(url);
      }
    };
    take(home);
    while (queue.length > 0 && routes.length < MAX_ROUTES) {
      const visited = await visit(page, queue.shift()!);
      if (!("problem" in visited)) take(visited);
    }
    return { url: home.url, routes };
  } finally {
    await page.context().close();
  }
}

/** Opens one address and returns where it ended up, its links and its document, or why it is not a page. */
async function visit(page: Page, url: URL): Promise<Visit> {
  let response;
  try {
    response = await page.goto(url.href, { waitUntil: "load" });
  } catch {
    return { problem: `The review could not reach ${url.href}. Check that your Site is being served and that the address is right.` };
  }
  const status = response?.status() ?? 0;
  if (status >= 400) {
    return { problem: `The review could not open ${url.href}: the server answered ${status} instead of a page. Check the address.` };
  }
  const type = response?.headers()["content-type"] ?? "text/html";
  if (!type.includes("html")) {
    return {
      problem: `The review could not open ${url.href} as a page: the server answered with ${type.split(";")[0]} instead of HTML. Give the address of your Site's home page.`,
    };
  }
  return settled(page, async () => {
    const links = await page.$$eval("a[href]", (anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
    return { url: new URL(page.url()), links, html: await page.content() };
  });
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
 * One key per document, known only once it opened: /x, /x/ and /x/index.html,
 * with any query string, are one route when they serve the same document. A
 * query string that changes the document makes a route of its own.
 */
function documentKey(url: URL, html: string): string {
  let path = url.pathname.replace(/\/index\.html?$/i, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${url.origin}${path} ${createHash("sha256").update(html).digest("hex")}`;
}

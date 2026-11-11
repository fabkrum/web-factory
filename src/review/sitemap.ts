import type { Failure, ReviewCheck } from "./check.ts";
import { fetchFromSite, onSite } from "./fetch.ts";
import { routeOf } from "./routes.ts";

/** Where a Site's sitemap usually is when robots.txt names none; Astro's sitemap integration writes the second. */
const USUAL_PLACES = ["/sitemap.xml", "/sitemap-index.xml"];

/** Stops a sitemap index that points at itself, or at thousands of files, from making the review endless. */
const MAX_SITEMAPS = 50;

/** What the sitemap lists, or why there is none to read. */
type Sitemap = { listed: Set<string>; at: string } | { failure: Failure };

export const sitemapCheck: ReviewCheck = {
  id: "visibility/sitemap",
  name: "Sitemap lists every route",
  area: "Visibility",
  async run(site) {
    const sitemap = await readSitemap(site.url);
    if ("failure" in sitemap) return [sitemap.failure];
    return site.routes
      .filter((route) => !sitemap.listed.has(route.path))
      .map((route) => ({
        reason: `The sitemap (${sitemap.at}) does not list ${route.path}, so search engines may find this page late or not at all. Add its address to the sitemap.`,
        location: route.path,
      }));
  },
};

/**
 * Reads the sitemaps robots.txt names, or the one in the usual place, and every
 * sitemap a sitemap index points at. Listed addresses count by route, wherever
 * they are hosted: the sitemap names the live Site, the review may run on a Preview.
 */
async function readSitemap(site: URL): Promise<Sitemap> {
  const robots = await fetchFromSite(new URL("/robots.txt", site.origin));
  const named = robots && robots.status < 400 ? [...robots.body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((match) => match[1]!) : [];
  const start = named.length > 0 ? named : await usualPlace(site);
  if (start.length === 0) {
    return {
      failure: {
        reason: `The Site has no sitemap: robots.txt names none (a "Sitemap:" line) and nothing answers at ${USUAL_PLACES.join(" or ")}. Search engines then find only the pages they can reach by links. Publish a sitemap that lists every page, and name it in robots.txt.`,
        location: USUAL_PLACES[0]!,
      },
    };
  }
  const listed = new Set<string>();
  const queue = start.map((address) => ({ address, from: named.length > 0 ? "robots.txt" : undefined }));
  const read = new Set<string>();
  while (queue.length > 0 && read.size < MAX_SITEMAPS) {
    const { address, from } = queue.shift()!;
    const url = onSite(address, site);
    if (!url || read.has(url.href)) continue;
    read.add(url.href);
    const naming = from ? ` ${from} names it as ${address}, but` : "";
    const fetched = await fetchFromSite(url);
    if (!fetched || fetched.status >= 400) {
      const answer = fetched ? `answers ${fetched.status}` : "does not answer";
      return { failure: { reason: `The sitemap at ${url.pathname} could not be read:${naming} it ${answer}. Search engines cannot read it either. Publish it at that address.`, location: url.pathname } };
    }
    const locations = [...fetched.body.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?\s*<\/loc>/gs)].map((match) => unescapeXml(match[1]!));
    if (/<sitemapindex[\s>]/.test(fetched.body)) {
      queue.push(...locations.map((location) => ({ address: location, from: `the sitemap index ${url.pathname}` })));
    } else if (/<urlset[\s>]/.test(fetched.body)) {
      for (const location of locations) {
        const page = onSite(location, site);
        if (page) listed.add(routeOf(page));
      }
    } else {
      return {
        failure: {
          reason: `The file at ${url.pathname} is not a sitemap:${naming} it holds no <urlset> or <sitemapindex>, so search engines ignore it. Publish a sitemap in the sitemaps.org XML format.`,
          location: url.pathname,
        },
      };
    }
  }
  return { listed, at: start.map((address) => onSite(address, site)?.pathname ?? address).join(", ") };
}

/** The first usual place a sitemap answers at, or none. */
async function usualPlace(site: URL): Promise<string[]> {
  for (const path of USUAL_PLACES) {
    const fetched = await fetchFromSite(new URL(path, site.origin));
    if (fetched && fetched.status < 400) return [path];
  }
  return [];
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

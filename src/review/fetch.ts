/** How long the review waits for one file the Site serves (a sitemap, robots.txt, a page) before it treats it as not there. */
const FETCH_TIMEOUT = 15_000;

/** What the Site answered for one address, after redirects. */
export interface Fetched {
  status: number;
  /** Where the address ended up after redirects. */
  url: URL;
  contentType: string;
  headers: Headers;
  body: string;
}

/**
 * Asks the Site for one address the way a search engine's crawler does: no
 * browser, redirects followed. Undefined when the Site does not answer at all.
 */
export async function fetchFromSite(url: URL): Promise<Fetched | undefined> {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    return {
      status: response.status,
      url: new URL(response.url || url.href),
      contentType: response.headers.get("content-type") ?? "",
      headers: response.headers,
      body: await response.text(),
    };
  } catch {
    return undefined;
  }
}

/**
 * The same path and query on the served Site. A sitemap or robots.txt names the
 * Site's live addresses (https://www.example.com/…), while the review measures
 * it wherever it is served (a Preview, localhost).
 */
export function onSite(address: string, site: URL): URL | undefined {
  try {
    const url = new URL(address, site);
    return new URL(`${url.pathname}${url.search}`, site.origin);
  } catch {
    return undefined;
  }
}

import type { Failure, ReviewCheck, Route } from "./check.ts";
import { fetchFromSite, type Fetched } from "./fetch.ts";

export const oneUrlCheck: ReviewCheck = {
  id: "visibility/one-url",
  name: "One URL per page",
  area: "Visibility",
  async run(site) {
    const pages: { route: Route; page: Fetched }[] = [];
    for (const route of site.routes) {
      if (route.problem) continue;
      const page = await fetchFromSite(route.address);
      if (page && isPage(page)) pages.push({ route, page });
    }
    const failures: Failure[] = [];
    /** Pairs of addresses already reported, so two routes that are one page fail once, not once each. */
    const reported = new Set<string>();
    const report = (route: Route, at: URL, other: URL) => {
      const pair = [at.pathname, other.pathname].sort().join(" ");
      if (reported.has(pair)) return;
      reported.add(pair);
      failures.push({
        reason: `This page is also served at ${other.pathname}, so search engines may list it twice and split its ranking between the two addresses. Redirect ${other.pathname} to ${at.pathname} (most hosts have a setting for clean URLs and trailing slashes), or remove the copy.`,
        location: route.path,
      });
    };
    for (const [i, { route, page }] of pages.entries()) {
      for (const other of pages.slice(i + 1)) {
        if (other.page.body === page.body) report(route, page.url, other.page.url);
      }
      for (const form of otherForms(page.url)) {
        const answer = await fetchFromSite(form);
        if (answer && isPage(answer) && answer.url.pathname !== page.url.pathname && answer.body === page.body) report(route, page.url, answer.url);
      }
    }
    return failures;
  },
};

/** An HTML page the Site answered with, not an error page. */
function isPage(fetched: Fetched): boolean {
  return fetched.status < 400 && fetched.contentType.includes("html");
}

/**
 * The other addresses a static host often serves the same page at: with and
 * without a trailing slash, with and without .html, and a folder's index.html.
 * The same page answering at one of them, without a redirect to the page's own
 * address, is a second URL for it. A different page answering there is not.
 */
function otherForms(url: URL): URL[] {
  const path = url.pathname;
  const forms =
    path === "/"
      ? ["/index.html"]
      : path.endsWith("/index.html")
        ? [path.slice(0, -"index.html".length)]
        : path.endsWith("/")
          ? [path.slice(0, -1), `${path}index.html`]
          : path.endsWith(".html")
            ? [path.slice(0, -".html".length), `${path.slice(0, -".html".length)}/`]
            : [`${path}/`, `${path}.html`];
  return forms.map((form) => new URL(`${form}${url.search}`, url.origin));
}

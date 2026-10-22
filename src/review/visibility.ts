import { goTo, openReviewPage, PageError, reopen, settled } from "./browser.ts";
import type { Failure, ReviewCheck, Route, SiteUnderReview } from "./check.ts";

/** The social preview tags every route needs, from the Open Graph protocol that social networks and chat apps read. */
const SOCIAL_TAGS = ["og:title", "og:description", "og:image"] as const;

/** What a page tells search engines and social networks about itself, read from the page a browser shows. */
interface Head {
  /** Where the page settled. */
  url: string;
  /** The href of every canonical link in the head, as written. */
  canonicals: string[];
  /** Each social preview tag's content as written, or null when the page has none. */
  social: Record<(typeof SOCIAL_TAGS)[number], string | null>;
  /** The text of every JSON-LD script on the page. */
  structuredData: string[];
}

type RouteHead = { route: Route; head: Head } | { route: Route; problem: string };

/** The Visibility checks share one visit to every route, so each page is opened once for all three. */
const heads = new WeakMap<SiteUnderReview, Promise<RouteHead[]>>();

function readHeads(site: SiteUnderReview): Promise<RouteHead[]> {
  let read = heads.get(site);
  if (!read) {
    read = visitEveryRoute(site);
    heads.set(site, read);
  }
  return read;
}

/**
 * Opens every route in the browser, so tags a script adds count as they do for
 * search engines that render pages. A page that cannot be opened is that
 * route's failure in every check that reads it.
 */
async function visitEveryRoute(site: SiteUnderReview): Promise<RouteHead[]> {
  const read: RouteHead[] = [];
  let page = await openReviewPage(site.browser);
  try {
    for (const route of site.routes) {
      if (route.problem) {
        read.push({ route, problem: route.problem });
        continue;
      }
      try {
        await goTo(page, route.address);
        const head = await settled(page, () =>
          page.evaluate(
            (tags) => ({
              url: location.href,
              canonicals: [...document.querySelectorAll('head link[rel~="canonical" i]')].map((link) => link.getAttribute("href") ?? ""),
              social: Object.fromEntries(
                tags.map((tag) => [tag, document.querySelector(`meta[property="${tag}"], meta[name="${tag}"]`)?.getAttribute("content") ?? null]),
              ) as Head["social"],
              structuredData: [...document.querySelectorAll('script[type="application/ld+json" i]')].map((script) => script.textContent ?? ""),
            }),
            [...SOCIAL_TAGS],
          ),
        );
        read.push({ route, head });
      } catch (error) {
        if (!(error instanceof PageError)) throw error;
        read.push({ route, problem: error.message });
        page = await reopen(page);
      }
    }
  } finally {
    await page.context().close();
  }
  return read;
}

/** A Visibility check that reads each route's head and judges it alone. */
function perRoute(check: Omit<ReviewCheck, "run" | "area">, judge: (route: Route, head: Head) => Failure[]): ReviewCheck {
  return {
    ...check,
    area: "Visibility",
    async run(site) {
      return (await readHeads(site)).flatMap((read) =>
        "problem" in read ? [{ reason: read.problem, location: read.route.path }] : judge(read.route, read.head),
      );
    },
  };
}

export const canonicalCheck = perRoute({ id: "visibility/canonical", name: "Canonical URL on every route" }, (route, head) => {
  const fail = (reason: string) => [{ reason, location: route.path }];
  const own = new URL(head.url);
  const canonicals = [...new Set(head.canonicals.map((href) => href.trim()))];
  if (canonicals.length === 0) {
    return fail(
      `This page has no canonical URL (<link rel="canonical"> in its head), so when it can be reached at more than one address, search engines guess which one is the real one. Add one that points at this page's own address, ${own.pathname}.`,
    );
  }
  if (canonicals.length > 1) {
    return fail(`This page names ${canonicals.length} different canonical URLs (${canonicals.join(", ")}), so search engines ignore them all. Keep one, pointing at this page's own address, ${own.pathname}.`);
  }
  const href = canonicals[0]!;
  // An empty or fragment-only href resolves to the page itself, yet names no address: search engines ignore it.
  if (href === "" || href.startsWith("#")) {
    return fail(
      `This page's canonical tag (<link rel="canonical">) names no address${href ? ` ("${href}")` : ""}, so search engines ignore it and the page has no canonical URL. Point its href at this page's own address, ${own.pathname}.`,
    );
  }
  const canonical = parseWebAddress(href, own);
  if (!canonical) return fail(`This page's canonical URL "${href}" is not a web address, so search engines ignore it. Point it at this page's own address, ${own.pathname}.`);
  // The host may differ: a canonical names the live Site, and the review may run on a Preview.
  if (canonical.pathname !== own.pathname) {
    return fail(
      `This page's canonical URL points at ${canonical.href}, not at this page (${own.pathname}), so search engines may leave this page out of their results in favour of that one. Point it at this page's own address.`,
    );
  }
  return [];
});

export const socialPreviewCheck = perRoute({ id: "visibility/social-preview", name: "Social preview tags on every route" }, (route, head) => {
  const missing = SOCIAL_TAGS.filter((tag) => !head.social[tag]?.trim());
  if (missing.length > 0) {
    return [
      {
        reason: `This page has no ${missing.join(", ")} (Open Graph social preview tags), so when someone shares it in a chat or on a social network the preview shows no ${missing.map((tag) => DESCRIBED[tag]).join(" and no ")}. Add <meta property="${missing[0]}" content="…"> and the others to its head.`,
        location: route.path,
      },
    ];
  }
  const image = head.social["og:image"]!.trim();
  if (!parseWebAddress(image)) {
    return [
      {
        reason: `This page's og:image "${image}" is not a full address starting with https://, and most social networks and chat apps load no picture from anything less. Give the image's full address.`,
        location: route.path,
      },
    ];
  }
  return [];
});

const DESCRIBED: Record<(typeof SOCIAL_TAGS)[number], string> = {
  "og:title": "title",
  "og:description": "description",
  "og:image": "picture",
};

export const structuredDataCheck = perRoute({ id: "visibility/structured-data", name: "Structured data parses" }, (route, head) =>
  head.structuredData.flatMap((text, i) => {
    const location = `${route.path} at <script type="application/ld+json">${head.structuredData.length > 1 ? ` number ${i + 1}` : ""}`;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return [
        {
          reason: `This page's structured data (JSON-LD) does not parse: ${(error as Error).message}. Search engines ignore all of it, so the page gets no rich results. Fix the JSON there; a trailing comma or a missing quote is the usual cause.`,
          location,
        },
      ];
    }
    const items = Array.isArray(data) ? data : [data];
    if (items.every((item) => typeof item === "object" && item !== null && "@context" in item && ("@type" in item || "@graph" in item))) return [];
    return [
      {
        reason: `This page's structured data (JSON-LD) parses but does not say what it describes: every item needs an "@context" (https://schema.org) and an "@type" (or an "@graph" of typed items), or search engines ignore it.`,
        location,
      },
    ];
  }),
);

/** An absolute http(s) address, resolved against `base` when one is given; undefined otherwise. */
function parseWebAddress(text: string, base?: URL): URL | undefined {
  try {
    const url = new URL(text, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

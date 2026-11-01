import type { Browser, Request } from "playwright";
import { goTo, PageError, settled } from "./browser.ts";
import type { Failure, ReviewCheck, Route, SiteUnderReview } from "./check.ts";
import { fetchFromSite, onSite } from "./fetch.ts";

/** Ends every reason this pack gives: it catches common mistakes and is no lawyer. */
const NOT_LEGAL_ADVICE = "This is not legal advice: the check catches common mistakes, nothing more.";

/** How long the pack keeps watching after a page settled, for a request a script makes a moment after load. */
const WATCH_AFTER_LOAD = 1_000;

/** One link on a page. */
interface Link {
  /** What the Visitor reads, or its aria-label. */
  text: string;
  /** The href as written. */
  written: string;
  /** Where it leads. */
  href: string;
}

/** A request the page made to someone other than the Site. */
interface ThirdPartyRequest {
  url: URL;
  font: boolean;
}

/** What a Visitor's browser did and showed on one route before they agreed to anything. */
interface Visit {
  route: Route;
  links: Link[];
  /** The page's visible text. */
  text: string;
  requests: ThirdPartyRequest[];
}

type RouteVisit = Visit | { route: Route; problem: string };

/** The pack's checks share one visit to every route, so each page is opened once for all of them. */
const visits = new WeakMap<SiteUnderReview, Promise<RouteVisit[]>>();

function visitOnce(site: SiteUnderReview): Promise<RouteVisit[]> {
  let visit = visits.get(site);
  if (!visit) {
    visit = visitEveryRoute(site);
    visits.set(site, visit);
  }
  return visit;
}

async function visitEveryRoute(site: SiteUnderReview): Promise<RouteVisit[]> {
  const visited: RouteVisit[] = [];
  for (const route of site.routes) {
    if (route.problem) visited.push({ route, problem: route.problem });
    else visited.push(await visit(site.browser, route, site.url));
  }
  return visited;
}

/**
 * Opens one route as a first-time Visitor who has clicked nothing: a fresh
 * browser with no cookies and nothing cached, the Site's own
 * Content-Security-Policy in force, so a request it blocks never leaves the
 * browser and does not count.
 */
async function visit(browser: Browser, route: Route, siteUrl: URL): Promise<RouteVisit> {
  const context = await browser.newContext();
  try {
    const requests: Request[] = [];
    context.on("request", (request) => requests.push(request));
    const page = await context.newPage();
    try {
      await goTo(page, route.address);
      const shown = await settled(page, async () => {
        await page.waitForTimeout(WATCH_AFTER_LOAD);
        return page.evaluate(() => ({
          text: document.body?.innerText ?? "",
          links: [...document.querySelectorAll("a[href]")]
            // A mailto: is no page, and a malformed address has no protocol to read.
            .filter((link) => link.checkVisibility() && /^https?:$/.test((link as HTMLAnchorElement).protocol))
            .map((link) => ({
              text: `${(link as HTMLElement).innerText} ${link.getAttribute("aria-label") ?? ""}`,
              written: link.getAttribute("href") ?? "",
              href: (link as HTMLAnchorElement).href,
            })),
        }));
      });
      return { route, requests: thirdPartyRequestsOf(requests, siteUrl), ...shown };
    } catch (error) {
      if (!(error instanceof PageError)) throw error;
      return { route, problem: error.message };
    }
  } finally {
    await context.close();
  }
}

/** The requests that left the browser for a third party; the browser reports one the Site's policy stopped as failed with "csp". */
function thirdPartyRequestsOf(requests: Request[], siteUrl: URL): ThirdPartyRequest[] {
  return requests
    .filter((request) => !/csp/i.test(request.failure()?.errorText ?? ""))
    .map((request) => ({ url: new URL(request.url()), font: request.resourceType() === "font" }))
    .filter(({ url }) => isThirdParty(url, siteUrl));
}

/**
 * Whether an address belongs to someone other than the Site. A subdomain of the
 * Site's own host name counts as the Site's: there is no way to tell from a
 * host name alone whether two sibling subdomains have one owner, so a sibling
 * counts as a third party.
 */
function isThirdParty(url: URL, siteUrl: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const own = siteUrl.hostname.replace(/^www\./, "");
  return url.hostname !== own && !url.hostname.endsWith(`.${own}`);
}

/** A check of the pack: it reads each route's visit, and every reason it gives says this is not legal advice. */
function packCheck(check: Pick<ReviewCheck, "id" | "name">, judge: (visit: Visit, site: SiteUnderReview) => Failure[] | Promise<Failure[]>): ReviewCheck {
  return {
    ...check,
    area: "Privacy & legal",
    localePack: "de",
    async run(site) {
      const failures: Failure[] = [];
      for (const visited of await visitOnce(site)) {
        if ("problem" in visited) failures.push({ reason: visited.problem, location: visited.route.path });
        else failures.push(...(await judge(visited, site)));
      }
      return failures.map((failure) => ({ ...failure, reason: `${failure.reason} ${NOT_LEGAL_ADVICE}` }));
    },
  };
}

const IMPRESSUM = /impressum|imprint|legal[\s_-]*notice|anbieterkennzeichnung/i;
const PRIVACY_POLICY = /datenschutz|privacy/i;

/** A page the law wants one click away, and how to word its absence. */
interface RequiredPage {
  pattern: RegExp;
  /** What the page is, for the reasons. */
  called: string;
  why: string;
  /** The link to add, as a Visitor reads it. */
  label: string;
}

const IMPRESSUM_PAGE: RequiredPage = {
  pattern: IMPRESSUM,
  called: "an Impressum",
  why: "German law wants the name and contact details of whoever runs a Site one click away from every page.",
  label: "Impressum",
};

const PRIVACY_POLICY_PAGE: RequiredPage = {
  pattern: PRIVACY_POLICY,
  called: "a privacy policy",
  why: "German law wants Visitors told what happens to their data, one click away from every page.",
  label: "Datenschutz",
};

/** Whether the pattern names this address's page, by its path or its #part. */
function pathMatches(pattern: RegExp, address: string): boolean {
  const url = new URL(address);
  return pattern.test(`${url.pathname}${url.hash}`);
}

/** A link that opens nothing: `#` or an empty href. */
function goesNowhere(link: Link): boolean {
  return /^\s*#?\s*$/.test(link.written);
}

/**
 * Every route must link to the page: a footer link is the usual way. The page
 * itself needs no link to itself, and a link must lead somewhere that answers.
 * A link to another party's address counts unopened: a company may keep its
 * Impressum on its main site.
 */
function pageLinked({ pattern, called, why, label }: RequiredPage): (visit: Visit, site: SiteUnderReview) => Promise<Failure[]> {
  return async ({ route, links }, site) => {
    if (pattern.test(route.path)) return [];
    const named = links.filter((link) => pattern.test(link.text) || pathMatches(pattern, link.href));
    const usable = named.filter((link) => !goesNowhere(link));
    if (usable.length === 0) {
      const dead = named.length > 0 ? `Its link "${label}" goes nowhere yet. ` : "";
      return [
        {
          reason: `This page has no working link to ${called}. ${dead}${why} Add a link labelled ${label} to the footer of every page, leading to a page that says it.`,
          location: route.path,
        },
      ];
    }
    let broken: { link: Link; answer: string } | undefined;
    for (const link of usable) {
      const answer = await targetProblem(link, site.url);
      if (!answer) return [];
      broken ??= { link, answer };
    }
    return [
      {
        reason: `This page links to ${called} at ${shownPath(broken!.link.href)}, but that page ${broken!.answer}. ${why} Make that page answer, or fix the link.`,
        location: route.path,
      },
    ];
  };
}

/** Why the page a link leads to is not there, or undefined when it answers. */
async function targetProblem(link: Link, siteUrl: URL): Promise<string | undefined> {
  const url = new URL(link.href);
  if (isThirdParty(url, siteUrl)) return undefined;
  // An absolute link names the live Site, while the review may be measuring a Preview.
  const answer = await fetchFromSite(onSite(link.href, siteUrl) ?? url);
  if (!answer) return "does not answer";
  return answer.status >= 200 && answer.status < 300 ? undefined : `answers with status ${answer.status}`;
}

function shownPath(address: string): string {
  const url = new URL(address);
  return `${url.pathname}${url.search}`;
}

/** An amount in euros as a page shows it: 49,00 €, EUR 49, 12 Euro. */
const PRICE = /\d[\d.,]*\s?(?:€|EUR\b|Euro\b)|(?:€|\bEUR\b)\s?\d[\d.,]*/i;

const VAT_WORD = String.raw`(?:MwSt|Mehrwertsteuer|USt|Umsatzsteuer|VAT)`;

/** The page says its prices include VAT, or states the small business rule that replaces it. */
const GROSS_PRICES = new RegExp(
  [
    String.raw`(?<!nicht\s|not\s)\b(?:inkl|inklusive|incl|including|enth[aä]lt|enthalten)\b[^\n]{0,40}?\b${VAT_WORD}\b`,
    String.raw`\b${VAT_WORD}\.?\s+(?:is\s+|ist\s+)?(?:included|enthalten)`,
    String.raw`\bbrutto`,
    String.raw`\bgross\s+price`,
    String.raw`§\s*19\s*UStG`,
    String.raw`Kleinunternehmer`,
  ].join("|"),
  "i",
);

function germanPrices({ route, text }: Visit): Failure[] {
  // An Impressum states a share capital and a privacy policy a fine: amounts, not prices.
  if (IMPRESSUM.test(route.path) || PRIVACY_POLICY.test(route.path)) return [];
  const price = PRICE.exec(text)?.[0];
  if (!price || GROSS_PRICES.test(text)) return [];
  return [
    {
      reason:
        'This page shows a price but does not say it is the full price with VAT. German law wants Visitors shown the gross price they will pay. Add "inkl. MwSt." next to the price, or once on the page for all of them. A small business under § 19 UStG that charges no VAT says that instead.',
      location: `${route.path} at "${price.trim()}"`,
    },
  ];
}

/** Each third party once per page: a tracker's tenth request says nothing its first did not. */
function firstPerHost(requests: ThirdPartyRequest[]): ThirdPartyRequest[] {
  const hosts = new Set<string>();
  return requests.filter(({ url }) => !hosts.has(url.host) && hosts.add(url.host));
}

function thirdPartyFonts({ route, requests }: Visit): Failure[] {
  return firstPerHost(requests.filter((request) => request.font)).map(({ url }) => ({
    reason: `This page loads a web font from ${url.hostname} before the Visitor has agreed to anything, which hands that company the Visitor's IP address. German courts have fined Sites for this. Put the font files in your Site and load them from there.`,
    location: `${route.path} to ${url.origin}${url.pathname}`,
  }));
}

function thirdPartyRequests({ route, requests }: Visit): Failure[] {
  return firstPerHost(requests.filter((request) => !request.font)).map(({ url }) => ({
    reason: `This page contacts ${url.hostname} before the Visitor has given consent, which hands that company the Visitor's IP address. Serve the file from your Site, or load it only after the Visitor has agreed in a consent banner.`,
    location: `${route.path} to ${url.origin}${url.pathname}`,
  }));
}

/** The German Locale pack: common mistakes under German law, measured on the served Site. */
export const GERMAN_LOCALE_PACK: ReviewCheck[] = [
  packCheck({ id: "legal/impressum", name: "Impressum one click from every route" }, pageLinked(IMPRESSUM_PAGE)),
  packCheck({ id: "legal/privacy-policy", name: "Privacy policy one click from every route" }, pageLinked(PRIVACY_POLICY_PAGE)),
  packCheck({ id: "legal/german-prices", name: "Prices shown as gross prices including VAT" }, germanPrices),
  packCheck({ id: "legal/third-party-fonts", name: "No web fonts from a third party before consent" }, thirdPartyFonts),
  packCheck({ id: "legal/third-party-requests", name: "No third-party requests before consent" }, thirdPartyRequests),
];

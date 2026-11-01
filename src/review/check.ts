import type { Browser } from "playwright";
import type { LocalePack } from "../config.ts";

/** The five Review areas every Ticket is checked in, in the order the Builder sees them. */
export const REVIEW_AREAS = ["Performance", "Accessibility", "Privacy & legal", "Visibility", "Code & security"] as const;

export type ReviewArea = (typeof REVIEW_AREAS)[number];

/** One reason a Review check failed, in plain language, and where. */
export interface Failure {
  reason: string;
  /** The route, and where on it when the check can say, e.g. "/about.html at .faint". */
  location: string;
}

/** One route of the Site, and the address it first opened as a page at, where checks open it. */
export interface Route {
  /** The URL's path without query string and without a trailing slash; the root stays "/". */
  path: string;
  address: URL;
  /** Why the page failed to open when the routes were found, in plain language; checks report it instead of opening it again. */
  problem?: string;
}

/** The served Site a Review check measures. */
export interface SiteUnderReview {
  /** Where the address the Builder gave ended up after redirects; the routes are on its origin. */
  url: URL;
  /** Every route found on the Site, e.g. "/" or "/about.html". */
  routes: Route[];
  browser: Browser;
  /** The Site's repository folder (where its factory.json is), when the review runs from one. */
  repo?: string;
}

/** One measurement in a Review area, made by a tool: no failures means it passes. */
export interface ReviewCheck {
  id: string;
  name: string;
  area: ReviewArea;
  /** True for a check that reads the Site's repository (its tests, its dependencies): it runs only when there is one. */
  needsRepo?: boolean;
  /** The Locale pack this check belongs to: it runs only on a Site with that pack on. */
  localePack?: LocalePack;
  run(site: SiteUnderReview): Promise<Failure[] | NotRun>;
}

/** What a check returns when it could not measure this Site at all, with why in plain language; it does not stop a Pass. */
export interface NotRun {
  notRun: string;
}

/** Anything that stops a review from measuring the Site at all, in words the Builder can act on. */
export class ReviewError extends Error {}

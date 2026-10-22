import type { Browser } from "playwright";

/** The five Review areas every Ticket is checked in, in the order the Builder sees them. */
export const REVIEW_AREAS = ["Performance", "Accessibility", "Privacy & legal", "Visibility", "Code & security"] as const;

export type ReviewArea = (typeof REVIEW_AREAS)[number];

/** One reason a Review check failed, in plain language, and where. */
export interface Failure {
  reason: string;
  /** The route, and where on it when the check can say, e.g. "/about.html at .faint". */
  location: string;
}

/** The served Site a Review check measures. */
export interface SiteUnderReview {
  /** Where the address the Builder gave ended up after redirects; the routes are relative to it. */
  url: URL;
  /** Every route found on the Site, as a path, e.g. "/about.html". */
  routes: string[];
  browser: Browser;
}

/** One measurement in a Review area, made by a tool: no failures means it passes. */
export interface ReviewCheck {
  id: string;
  name: string;
  area: ReviewArea;
  run(site: SiteUnderReview): Promise<Failure[]>;
}

/** Anything that stops a review from measuring the Site at all, in words the Builder can act on. */
export class ReviewError extends Error {}

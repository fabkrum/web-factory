/**
 * Whether a Request is about the Site or about the Factory's setup in the Site (ADR 0006). Every
 * Request the Factory files carries one of these labels; its Spec is the same issue, and its
 * Tickets carry their Spec's.
 */
export const ABOUTS = ["site", "factory"] as const;

export type About = (typeof ABOUTS)[number];

export function aboutLabel(about: About): string {
  return `about:${about}`;
}

/** What an issue's labels say it is about; undefined for one filed by hand without the label. */
export function aboutOf(labels: string[]): About | undefined {
  const lower = labels.map((label) => label.toLowerCase());
  return ABOUTS.find((about) => lower.includes(aboutLabel(about)));
}

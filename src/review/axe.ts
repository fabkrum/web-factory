import axe, { type AxeResults, type NodeResult, type Result } from "axe-core";
import { openReviewPage } from "./browser.ts";
import type { Failure, ReviewCheck } from "./check.ts";

/**
 * The WCAG 2.2 A and AA rules. axe's best-practice rules are left out: they are
 * advice, not the standard, and failing a Builder's Site on advice is the friction
 * the site machine's evidence warned about.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** Plain-language reasons for the rules a beginner's Site breaks most; any other rule falls back to axe's own summary. */
const REASONS: Record<string, (node: NodeResult) => string> = {
  "color-contrast": (node) => {
    const data = node.any[0]?.data as
      | { contrastRatio?: number; expectedContrastRatio?: string; fgColor?: string; bgColor?: string }
      | undefined;
    const measured = data?.contrastRatio ? ` its contrast is ${data.contrastRatio}:1 (${data.fgColor} on ${data.bgColor}) and` : "";
    const needed = data?.expectedContrastRatio ?? "4.5:1";
    return `This text is too faint against its background:${measured} it needs at least ${needed}, so people with low vision or on a bright screen cannot read it.`;
  },
  "image-alt": () =>
    "This image has no text alternative (alt), so people who cannot see it get no idea what it shows. Describe it in alt, or use alt=\"\" if it is only decoration.",
  "link-name": () => "This link has no text a screen reader can say, so people who cannot see it do not know where it goes.",
  "button-name": () => "This button has no text a screen reader can say, so people who cannot see it do not know what it does.",
  label: () => "This form field has no label, so people using a screen reader do not know what to type into it.",
  "html-has-lang": () =>
    "The page does not say which language it is in (lang on <html>), so screen readers may read it out with the wrong pronunciation.",
  "document-title": () => "The page has no <title>, so people cannot tell it apart from other tabs, bookmarks or search results.",
  "meta-viewport": () => "The page stops Visitors from zooming in, so people who need larger text cannot get it.",
};

export const axeCheck: ReviewCheck = {
  id: "accessibility/axe",
  name: "axe on every route",
  area: "Accessibility",
  async run(site) {
    const failures: Failure[] = [];
    const page = await openReviewPage(site.browser);
    try {
      for (const route of site.routes) {
        await page.goto(new URL(route, site.url).href, { waitUntil: "load" });
        await page.addScriptTag({ content: axe.source });
        const results = await page.evaluate(
          (tags) =>
            (globalThis as unknown as { axe: typeof axe }).axe.run(document, {
              runOnly: { type: "tag", values: tags },
              resultTypes: ["violations"],
            }),
          WCAG_TAGS,
        );
        failures.push(...failuresOn(route, results));
      }
    } finally {
      await page.context().close();
    }
    return failures;
  },
};

function failuresOn(route: string, results: AxeResults): Failure[] {
  return results.violations.flatMap((rule) =>
    rule.nodes.map((node) => ({
      reason: reasonFor(rule, node),
      location: `${route} at ${node.target.flat().join(" ")}: ${snippet(node.html)}`,
    })),
  );
}

/** The element's opening tag, so the Builder can find it in their own code. */
function snippet(html: string): string {
  const tag = html.slice(0, html.indexOf(">") + 1) || html;
  return tag.length > 100 ? `${tag.slice(0, 99)}…` : tag;
}

function reasonFor(rule: Result, node: NodeResult): string {
  return REASONS[rule.id]?.(node) ?? `${rule.help}. (axe rule ${rule.id}: ${rule.helpUrl})`;
}

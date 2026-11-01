import { afterEach, describe, expect, it } from "vitest";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages } from "./harness/served-pages.ts";

const THUMB = "accessibility/thumb-test";

/** Every check but Lighthouse, whose repeated runs add minutes and no coverage here. */
const CHECKS = [
  "accessibility/axe",
  THUMB,
  "visibility/sitemap",
  "visibility/canonical",
  "visibility/one-url",
  "visibility/social-preview",
  "visibility/structured-data",
  "security/headers",
  "code/console",
];

interface JsonCheck {
  id: string;
  passed: boolean;
  notApplicable?: string;
  skipped?: string;
  failures: { reason: string; location: string }[];
}

interface JsonReport {
  passed: boolean;
  areas: { area: string; checks: JsonCheck[] }[];
}

let site: ServedSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

async function review(url: string, checks: string[]) {
  const run = await runFactory(["review", url, "--json", ...checks.flatMap((id) => ["--check", id])], { cwd: process.cwd() });
  const report = JSON.parse(run.stdout) as JsonReport;
  return { run, report, thumb: report.areas.flatMap((area) => area.checks).find((check) => check.id === THUMB)! };
}

async function reviewFixture(fixture: string) {
  site = await serveFixtureSite(fixture);
  return review(site.url, CHECKS);
}

async function reviewPages(pages: Record<string, string>) {
  site = await servePages(pages);
  return review(site.url, [THUMB]);
}

function failingChecks(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks.filter((check) => !check.passed).map((check) => check.id));
}

const PHONE = `<meta name="viewport" content="width=device-width, initial-scale=1">`;

/** A one-file page at phone width: `css` and `body` make the menu, and `#page-link` fills the page behind it. */
function phonePage(css: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${PHONE}<title>Menu</title>
<style>body { margin: 0; } #page-link { display: block; height: 100vh; } ${css}</style></head>
<body>${body}<main><a id="page-link" href="/behind">Behind</a></main></body></html>`;
}

const TOGGLE_SCRIPT = `<script>
document.querySelector("button").addEventListener("click", () => document.getElementById("panel").classList.toggle("open"));
</script>`;

const PANEL_LINKS = `<a href="/one">One</a><a href="/two">Two</a>`;

/** A button opening a fixed panel; `open` is the panel's style when open. */
function panelPage(open: string, label = "Menu"): string {
  return phonePage(
    `#panel { display: none; } #panel.open { display: block; position: fixed; top: 3rem; left: 0; right: 0; background: #fff; z-index: 5; ${open} } #panel a { display: block; padding: 1rem; }`,
    `<button type="button">${label}</button><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}`,
  );
}

const ROUTES = { "/one": "<title>One</title>", "/two": "<title>Two</title>", "/behind": "<title>Behind</title>" };

describe("the thumb test", () => {
  it("fails a menu that lets taps reach the page behind, on exactly this check", async () => {
    const { run, report, thumb } = await reviewFixture("phone-menu-falls-through");

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual([THUMB]);
    expect(report.areas.find((area) => area.area === "Accessibility")!.checks.map((check) => check.id)).toContain(THUMB);
    expect(thumb.failures.map((failure) => failure.location)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/ at "Home"/), expect.stringMatching(/^\/ at "About"/), expect.stringMatching(/^\/about\.html at "About"/)]),
    );
    expect(thumb.failures[0]!.reason).toMatch(/page behind/i);
    expect(thumb.failures.some((failure) => /page-link/.test(failure.reason))).toBe(true);
  });

  it("Passes a working phone menu", async () => {
    const { run, report, thumb } = await reviewFixture("phone-menu");

    expect(run.exitCode).toBe(0);
    expect(failingChecks(report)).toEqual([]);
    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.passed).toBe(true);
  });

  it("reports a Site without a phone menu as not applicable, not failed and not as a check that did not run", async () => {
    const { run, report, thumb } = await reviewFixture("clean");

    expect(run.exitCode).toBe(0);
    expect(report.passed).toBe(true);
    expect(thumb.passed).toBe(true);
    expect(thumb.failures).toEqual([]);
    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.skipped).toBeUndefined();

    const text = await runFactory(["review", site!.url, "--check", THUMB], { cwd: process.cwd() });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toMatch(/NOT APPLICABLE\s+Phone menu/);
    expect(text.stdout).toMatch(/Passes every Review check\./);
  });

  it("catches a menu that only falls through on one route", async () => {
    const covered = phonePage(
      `#panel { display: none; } #panel.open { display: block; position: fixed; top: 3rem; left: 0; right: 0; z-index: 5; background: #fff; } #panel a { display: block; padding: 1rem; } main { position: relative; z-index: 9; }`,
      `<button type="button">Menu</button><nav id="panel">${PANEL_LINKS}<a href="/covered">Covered</a></nav>${TOGGLE_SCRIPT}`,
    );
    const { thumb } = await reviewPages({ "/": panelPage("").replace("</nav>", `<a href="/covered">Covered</a></nav>`), "/covered": covered, ...ROUTES });

    expect(thumb.passed).toBe(false);
    expect(new Set(thumb.failures.map((failure) => failure.location.split(" ")[0]))).toEqual(new Set(["/covered"]));
  });

  it("fails a menu button that opens nothing", async () => {
    const { thumb } = await reviewPages({ "/": phonePage("", `<button type="button">Menu</button>`) });

    expect(thumb.passed).toBe(false);
    expect(thumb.failures[0]!.location).toMatch(/^\/ at "Menu"/);
    expect(thumb.failures[0]!.reason).toMatch(/no links/i);
  });

  it("fails a menu item that runs off the screen", async () => {
    const { thumb } = await reviewPages({ "/": panelPage("height: 200vh; overflow: hidden;").replace("#panel a {", "#panel a:last-child { margin-top: 150vh; } #panel a {"), ...ROUTES });

    expect(thumb.passed).toBe(false);
    expect(thumb.failures).toHaveLength(1);
    expect(thumb.failures[0]!.location).toMatch(/^\/ at "Two"/);
    expect(thumb.failures[0]!.reason).toMatch(/off the screen|outside the screen/i);
  });

  it("taps a link in a menu that slides in", async () => {
    const page = phonePage(
      `#panel { position: fixed; top: 3rem; left: 0; right: 0; background: #fff; transform: translateX(100%); transition: transform 0.4s; } #panel.open { transform: none; } #panel a { display: block; padding: 1rem; } html { overflow-x: hidden; }`,
      `<button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}`,
    );
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it("taps a menu that unfolds from no height", async () => {
    const page = phonePage(
      `#panel { max-height: 0; overflow: hidden; transition: max-height 0.3s; background: #fff; position: relative; z-index: 2; } #panel.open { max-height: 20rem; } #panel a { display: block; padding: 1rem; }`,
      `<button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}`,
    );
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it("opens a menu made without a script, from a label or a details element", async () => {
    const label = phonePage(
      `#open { position: absolute; opacity: 0; } #panel { display: none; background: #fff; } #open:checked ~ #panel { display: block; } #panel a { display: block; padding: 1rem; }`,
      `<header><input id="open" type="checkbox" aria-label="Open"><label for="open">Open</label><nav id="panel">${PANEL_LINKS}</nav></header>`,
    );
    const details = phonePage(`#panel a { display: block; padding: 1rem; }`, `<header><details><summary>More</summary><nav id="panel">${PANEL_LINKS}</nav></details></header>`);

    for (const page of [label, details]) {
      const { thumb } = await reviewPages({ "/": page, ...ROUTES });
      await site?.close();
      site = undefined;
      expect(thumb.notApplicable).toBeUndefined();
      expect(thumb.failures).toEqual([]);
    }
  });

  it("tells an unnamed hamburger icon in the header from a button that opens no links", async () => {
    const icon = panelPage("", "").replace(`<button type="button"></button>`, `<header><button type="button" class="hamburger" aria-label="Open"></button></header>`);
    const { thumb } = await reviewPages({ "/": icon, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it("does not take a button that is no menu for a menu", async () => {
    const page = phonePage(
      `#faq-answer, #search { display: none; } #faq-answer.open, #search.open { display: block; }`,
      `<header><button id="find" type="button">Search</button><form id="search"><input aria-label="Find"></form></header>
<button id="faq" type="button" aria-expanded="false">What does it cost?</button><p id="faq-answer">See <a href="/one">the prices</a>.</p>
<header><a role="button" href="/two">Sign up</a></header>
<script>
document.getElementById("find").addEventListener("click", () => document.getElementById("search").classList.add("open"));
document.getElementById("faq").addEventListener("click", () => document.getElementById("faq-answer").classList.add("open"));
</script>`,
    );
    const { thumb } = await reviewPages({ "/": page, "/one": "<title>One</title>", "/two": "<title>Two</title>" });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.failures).toEqual([]);
  });

  it("does not leave the page or need the item's address to answer", async () => {
    const page = panelPage("").replace(`<a href="/two">Two</a>`, `<a href="#top">Two</a><a href="https://unreachable.invalid/" target="_blank">Three</a><a href="mailto:hello@example.com">Four</a>`);
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });
});

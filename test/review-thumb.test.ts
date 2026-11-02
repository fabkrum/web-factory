import { afterEach, describe, expect, it } from "vitest";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages, type Answer } from "./harness/served-pages.ts";

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

async function reviewPages(pages: Record<string, Answer>) {
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

  it("counts a menu button that opens nothing as no menu", async () => {
    const { thumb } = await reviewPages({ "/": phonePage("", `<button type="button">Menu</button>`) });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.failures).toEqual([]);
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

  /** A menu in the body, inserted on open as `{open && <nav>}` does, above links of the page that stay. */
  function insertedMenuPage(navStyle: string): string {
    const script = `<script>
document.querySelector("button").addEventListener("click", () => {
  document.querySelector("button").insertAdjacentHTML("afterend", '<nav id="panel" style="${navStyle}">${PANEL_LINKS}</nav>');
});
</script>`;
    return phonePage(
      `#panel { position: fixed; inset: 3rem 0 0 0; background: #fff; z-index: 5; } #panel a { display: block; padding: 1rem; }`,
      `<header><button type="button">Menu</button></header><a href="/p1">P1</a><a href="/p2">P2</a><a href="/p3">P3</a>${script}`,
    );
  }

  it("taps a menu that only exists while open, not the page links it pushes along", async () => {
    const { thumb } = await reviewPages({ "/": insertedMenuPage(""), ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it("catches a fall-through in a menu that only exists while open", async () => {
    const { thumb } = await reviewPages({ "/": insertedMenuPage("pointer-events: none"), ...ROUTES });

    expect(thumb.failures.map((failure) => failure.location)).toEqual(['/ at "One"', '/ at "Two"']);
    expect(thumb.failures[0]!.reason).toMatch(/page behind/i);
  });

  it.each([
    ["below the screen", "position: fixed; left: 0; right: 0; bottom: 0; transform: translateY(100%);", "transform: none;"],
    ["clipped to nothing", "position: fixed; left: 0; right: 0; top: 3rem; clip-path: inset(0 0 100% 0);", "clip-path: none;"],
    ["clipped to nothing in a polygon", "position: fixed; left: 0; right: 0; top: 3rem; clip-path: polygon(0 0, 100% 0, 100% 0, 0 0);", "clip-path: none;"],
  ])("opens a menu closed %s", async (_, closed, open) => {
    const page = phonePage(`#panel { background: #fff; z-index: 5; ${closed} } #panel.open { ${open} } #panel a { display: block; padding: 1rem; }`, `<button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}`);
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it.each([
    ["below the page", "position: absolute; left: 0; right: 0; bottom: 0; transform: translateY(100%);", "transform: none; z-index: 5;"],
    ["behind an opaque header", "position: fixed; left: 0; right: 0; top: 3rem; z-index: 1; transform: translateY(-100%);", "transform: none;"],
    ["under the page", "position: fixed; left: 0; right: 0; top: 3rem; z-index: -1;", "z-index: 5;"],
    ["clipped by a calculated inset", "position: fixed; left: 0; right: 0; top: 3rem; clip-path: inset(0 0 calc(100% + 1px) 0);", "clip-path: none; z-index: 5;"],
    ["clipped to a flat ellipse", "position: fixed; left: 0; right: 0; top: 3rem; clip-path: ellipse(50% 0 at 50% 0);", "clip-path: none; z-index: 5;"],
    ["clipped by an evenodd polygon", "position: fixed; left: 0; right: 0; top: 3rem; clip-path: polygon(evenodd, 0 0, 100% 0, 100% 0, 0 0);", "clip-path: none; z-index: 5;"],
  ])("Passes a menu closed %s and finds its fall-through", async (_, closed, open) => {
    const page = (extra: string) =>
      phonePage(
        `header { position: fixed; top: 0; left: 0; right: 0; height: 3rem; background: #fff; z-index: 3; } main { padding-top: 3rem; background: #fff; position: relative; } #panel { background: #fff; ${closed} } #panel.open { ${open} ${extra} } #panel a { display: block; padding: 1rem; }`,
        `<header><button type="button">Menu</button></header><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}`,
      );

    const working = (await reviewPages({ "/": page(""), ...ROUTES })).thumb;
    await site?.close();
    site = undefined;
    const fallsThrough = (await reviewPages({ "/": page("pointer-events: none;"), ...ROUTES })).thumb;

    expect(working.notApplicable).toBeUndefined();
    expect(working.failures).toEqual([]);
    expect(fallsThrough.failures.map((failure) => failure.location)).toEqual(['/ at "One"', '/ at "Two"']);
  });

  /** A closed 200px drawer of twenty links, the last with `last` for its style. */
  function drawerPage(closed: string, open: string, last: string): string {
    const links = Array.from({ length: 20 }, (_, index) => `<a href="/${index}"${index === 19 ? ` style="${last}"` : ""}>Item${index}</a>`).join("");
    return phonePage(
      `#panel { position: fixed; top: 3rem; left: 0; right: 0; height: 200px; overflow-y: auto; background: #fff; z-index: 5; ${closed} } #panel.open { ${open} } #panel a { display: block; padding: 1rem; }`,
      `<button type="button">Menu</button><nav id="panel">${links}</nav>${TOGGLE_SCRIPT}`,
    );
  }

  it.each([
    ["with display", "display: none;", "display: block;"],
    ["off the bottom of the screen", "top: auto; bottom: 0; transform: translateY(100%);", "transform: none;"],
  ])("taps the items past the fold of a scrolling menu closed %s", async (_, closed, open) => {
    const { thumb } = await reviewPages({ "/": drawerPage(closed, open, "pointer-events: none"), ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures.map((failure) => failure.location)).toEqual(['/ at "Item19"']);
  });

  it.each([
    ["a circle over 1 s", "circle(0 at 0 0)", "circle(150% at 0 0)", "1s"],
    ["a circle over 0.6 s", "circle(0 at 0 0)", "circle(150% at 0 0)", "0.6s"],
    ["an inset over 1 s", "inset(0 0 100% 0)", "inset(0)", "1s"],
  ])("waits for a menu revealed with %s", async (_, closed, open, time) => {
    const page = phonePage(
      `#panel { position: fixed; top: 3rem; left: 0; right: 0; background: #fff; z-index: 5; clip-path: ${closed}; transition: clip-path ${time}; } #panel.open { clip-path: ${open}; } #panel a { display: block; padding: 1rem; }`,
      `<button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}`,
    );
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it("does not take a closed bottom sheet for what another button opened", async () => {
    const page = phonePage(
      `#panel { position: fixed; left: 0; right: 0; bottom: 0; transform: translateY(100%); }`,
      `<header><button type="button">Search</button></header><nav id="panel">${PANEL_LINKS}</nav>`,
    );
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
  });

  it("reopens a bottom sheet that closes as an item is tapped", async () => {
    const page = phonePage(
      `#panel { position: fixed; left: 0; right: 0; bottom: 0; background: #fff; transform: translateY(100%); } #panel.open { transform: none; } #panel a { display: block; padding: 1rem; }`,
      `<button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav>${TOGGLE_SCRIPT}
<script>window.addEventListener("click", (event) => { if (event.target.closest("#panel")) document.getElementById("panel").classList.remove("open"); }, true);</script>`,
    );
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });

  it.each([
    ["See our menu", `<button type="button">See our menu</button>`],
    ["Print the menu of the day", `<button type="button">Print the menu of the day</button>`],
    ["an accordion about the menu", `<button type="button" aria-expanded="false">Our menu</button>`],
    ["btn-navy", `<button type="button" class="btn btn-navy">Book</button>`],
    ["carousel-nav", `<button type="button" class="carousel-nav" aria-controls="slides">Next</button><div id="slides"></div>`],
    ["a hero's See our menu", `<header class="hero"><button type="button">See our menu</button></header>`],
    ["an accordion in a section header", `<section><header><button type="button">Our menu</button></header></section>`],
    ["Print menu", `<header><button type="button">Print menu</button></header>`],
    ["Tagesmenü", `<button type="button">Tagesmenü</button>`],
    ["a tab", `<button type="button" role="tab">Menu</button>`],
    ["nav-button", `<button type="button" class="nav-button" aria-controls="slides">Next</button><div id="slides"></div>`],
  ])("does not fail a Site without a menu for a button like %s", async (_, button) => {
    const { thumb } = await reviewPages({ "/": phonePage("", button) });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.failures).toEqual([]);
  });

  it("counts a button in the header or wired to a menu that opens nothing as no menu", async () => {
    for (const button of [`<header><button type="button">Open the menu</button></header>`, `<button type="button" class="hamburger" aria-controls="mobile-menu" aria-label="Open"></button>`]) {
      const { thumb } = await reviewPages({ "/": phonePage("", button) });
      await site?.close();
      site = undefined;
      expect(thumb.notApplicable).toMatch(/no .*menu/i);
      expect(thumb.failures).toEqual([]);
    }
  });

  it("is not thrown off by controls and links inside a shadow root", async () => {
    const shadow = `<x-widget></x-widget><script>
document.querySelector("x-widget").attachShadow({ mode: "open" }).innerHTML = '<a href="/one">Shadow link</a><button type="button">Close</button>';
</script>`;
    const page = (open: string) =>
      phonePage(
        `#panel { display: none; } #panel.open { display: block; position: fixed; top: 6rem; left: 0; right: 0; background: #fff; z-index: 5; ${open} } #panel a { display: block; padding: 1rem; }`,
        `${shadow}<header><button id="menu" type="button">Menu</button></header><nav id="panel">${PANEL_LINKS}</nav>
<script>document.getElementById("menu").addEventListener("click", () => document.getElementById("panel").classList.toggle("open"));</script>`,
      );

    const working = (await reviewPages({ "/": page(""), ...ROUTES })).thumb;
    await site?.close();
    site = undefined;
    const fallsThrough = (await reviewPages({ "/": page("pointer-events: none;"), ...ROUTES })).thumb;

    expect(working.notApplicable).toBeUndefined();
    expect(working.failures).toEqual([]);
    expect(fallsThrough.failures.map((failure) => failure.location)).toEqual(['/ at "One"', '/ at "Two"']);
  });

  it("takes a button that reloads the page at the same address for no menu", async () => {
    const page = phonePage("", `<header><button type="button" onclick="location.reload()">Refresh</button></header>`);
    const { thumb } = await reviewPages({ "/": page });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.failures).toEqual([]);
  });

  it.each([
    ["ontouchend", `ontouchend="location.href='/one'"`],
    ["onpointerdown", `onpointerdown="location.href='/one'"`],
    ["ontouchstart with a replace", `ontouchstart="location.replace('/one')"`],
  ])("counts an item that leaves the page on the touch itself (%s) as tapped, and goes on to the next", async (_, handler) => {
    const page = (open: string) => panelPage(open).replace(`<a href="/one">`, `<a href="/one" ${handler}>`);

    const working = (await reviewPages({ "/": page(""), ...ROUTES })).thumb;
    await site?.close();
    site = undefined;
    const nextFallsThrough = (await reviewPages({ "/": page("").replace("</style>", "#panel a + a { pointer-events: none; }</style>"), ...ROUTES })).thumb;

    expect(working.notApplicable).toBeUndefined();
    expect(working.failures).toEqual([]);
    expect(nextFallsThrough.failures.map((failure) => failure.location)).toEqual(['/ at "Two"']);
    expect(nextFallsThrough.failures[0]!.reason).toMatch(/page behind/i);
  });

  it("does not stop the review when every item leaves the page, and the next check still runs", async () => {
    const leaves = (path: string) => `ontouchend="location.href='${path}'"`;
    const page = panelPage("").replace(`<a href="/one">`, `<a href="/one" ${leaves("/one")}>`).replace(`<a href="/two">`, `<a href="/two" ${leaves("/two")}>`);
    site = await servePages({ "/": page, ...ROUTES });
    const { run, report, thumb } = await review(site.url, [THUMB, "visibility/canonical"]);

    expect(run.exitCode).not.toBe(3);
    expect(thumb.failures).toEqual([]);
    expect(thumb.notApplicable).toBeUndefined();
    expect(report.areas.flatMap((area) => area.checks).map((check) => check.id)).toContain("visibility/canonical");
  });

  it("does not take an item that leaves for a slow page for a page that cannot open, and taps the rest", async () => {
    const slow: Answer = (_, response) => {
      setTimeout(() => response.writeHead(200, { "content-type": "text/html" }).end("<title>Slow</title>"), 2_500);
    };
    const page = panelPage("").replace(`<a href="/one">`, `<a href="/one" ontouchend="location.href='/one'">`).replace("</style>", "#panel a + a { pointer-events: none; }</style>");
    const { thumb } = await reviewPages({ "/": page, ...ROUTES, "/one": slow });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures.map((failure) => failure.location)).toEqual(['/ at "Two"']);
    expect(thumb.failures[0]!.reason).toMatch(/page behind/i);
  });

  it.each([[0], [20], [50], [120]])("taps on past an item that leaves %i ms after the touch", async (delay) => {
    const page = panelPage("")
      .replace(`<a href="/one">`, `<a href="/one" ontouchend="setTimeout(() => location.href = '/one', ${delay})">`)
      .replace("</style>", "#panel a + a { pointer-events: none; }</style>");
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures.map((failure) => failure.location)).toEqual(['/ at "Two"']);
    expect(thumb.failures[0]!.reason).toMatch(/page behind/i);
  });

  it("still says so when a page leaves by itself every time, before an item can be touched", async () => {
    const fidgets = `<script>
document.querySelector("button").addEventListener("click", () => {
  let shift = 0;
  setInterval(() => document.querySelector("#panel a").style.marginLeft = ++shift + "px", 10);
  setTimeout(() => location.href = "/one", 1000);
});
</script>`;
    const { thumb } = await reviewPages({ "/": panelPage("").replace("</body>", `${fidgets}</body>`), ...ROUTES });

    expect(thumb.failures.map((failure) => failure.reason)).toEqual([expect.stringMatching(/by itself/)]);
  });

  it.each([["onpointerdown"], ["ontouchstart"], ["ontouchend"]])("catches a tap falling through to a page link that leaves on the touch (%s)", async (handler) => {
    const page = panelPage("pointer-events: none;").replace(`<a id="page-link" href="/behind">`, `<a id="page-link" href="/behind" ${handler}="location.href='/behind'">`);
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.failures.map((failure) => failure.location)).toEqual(['/ at "One"', '/ at "Two"']);
    expect(thumb.failures[0]!.reason).toMatch(/page behind.*page-link/i);
  });

  it.each([["div"], ["p"], ["h3"]])("sees a menu of links that each wrap a <%s>, and catches its taps falling through", async (block) => {
    const page = (open: string) =>
      phonePage(
        `#panel { display: none; } #panel.open { display: block; position: fixed; top: 3rem; left: 0; right: 0; background: #fff; z-index: 5; ${open} } #panel ${block} { margin: 0; padding: 1rem; }`,
        `<button type="button">Menu</button><nav id="panel"><a href="/one"><${block}>One</${block}></a><a href="/two"><${block}>Two</${block}></a></nav>${TOGGLE_SCRIPT}`,
      );

    const working = (await reviewPages({ "/": page(""), ...ROUTES })).thumb;
    await site?.close();
    site = undefined;
    const fallsThrough = (await reviewPages({ "/": page("pointer-events: none;"), ...ROUTES })).thumb;

    expect(working.notApplicable).toBeUndefined();
    expect(working.failures).toEqual([]);
    expect(fallsThrough.failures.map((failure) => failure.location)).toEqual(['/ at "One"', '/ at "Two"']);
  });

  it.each([
    ["fixed", "header { overflow: hidden; height: 3rem; }", "position: fixed; top: 3rem;"],
    ["absolute past a static ancestor", "header { overflow: hidden; height: 3rem; }", "position: absolute; top: 3rem;"],
  ])("sees a %s menu that escapes a header with overflow: hidden", async (_, header, position) => {
    const page = (open: string) =>
      phonePage(
        `${header} #panel { display: none; } #panel.open { display: block; ${position} left: 0; right: 0; background: #fff; z-index: 5; ${open} } #panel a { display: block; padding: 1rem; }`,
        `<header><button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav></header>${TOGGLE_SCRIPT}`,
      );

    const working = (await reviewPages({ "/": page(""), ...ROUTES })).thumb;
    await site?.close();
    site = undefined;
    const fallsThrough = (await reviewPages({ "/": page("pointer-events: none;"), ...ROUTES })).thumb;

    expect(working.notApplicable).toBeUndefined();
    expect(working.failures).toEqual([]);
    expect(fallsThrough.failures.map((failure) => failure.location)).toEqual(['/ at "One"', '/ at "Two"']);
  });

  it.each([
    ["fixed, held by a transformed ancestor", "transform: translateZ(0);", "position: fixed;"],
    ["absolute, held by a positioned ancestor", "position: relative;", "position: absolute;"],
  ])("counts a %s that clips it as cutting it away", async (_, holder, position) => {
    const page = phonePage(
      `header { overflow: hidden; height: 3rem; ${holder} } #panel { display: none; } #panel.open { display: block; ${position} top: 3rem; left: 0; right: 0; background: #fff; } #panel a { display: block; padding: 1rem; }`,
      `<header><button type="button">Menu</button><nav id="panel">${PANEL_LINKS}</nav></header>${TOGGLE_SCRIPT}`,
    );
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.failures).toEqual([]);
  });

  const NEVER = { "/never": () => {} };

  it("does not wait for a page that never answers when a header button goes there", async () => {
    const page = panelPage("").replace(`<button type="button">Menu</button>`, `<header><button type="button" onclick="location.href='/never'">Sign up</button></header>`);
    const { thumb } = await reviewPages({ "/": page, ...NEVER, ...ROUTES });

    expect(thumb.notApplicable).toMatch(/no .*menu/i);
    expect(thumb.failures).toEqual([]);
  }, 40_000);

  it("does not wait for a page that never answers when a menu item goes there on the touch", async () => {
    const page = panelPage("").replace(`<a href="/one">`, `<a href="/one" ontouchend="location.href='/never'">`);
    const { thumb } = await reviewPages({ "/": page, ...NEVER, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  }, 40_000);

  it("goes on to the next item when a tap the item took sends the page, a moment later, to one that never answers", async () => {
    const page = panelPage("").replace(`<a href="/one">`, `<a href="/one" ontouchend="setTimeout(() => location.href = '/never', 50)">`);
    const { thumb } = await reviewPages({ "/": page, ...NEVER, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  }, 40_000);

  describe("a dropdown that closes when the page scrolls", () => {
    const dropdown = (links: string, css = "") =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8">${PHONE}<title>Menu</title>
<style>body { margin: 0; } #panel { display: none; position: absolute; top: 3rem; left: 0; right: 0; background: #fff; z-index: 5; } #panel.open { display: block; } #panel a { display: block; padding: 1rem; } ${css}</style></head>
<body><button type="button">Menu</button><nav id="panel">${links}</nav><div style="height: 2000px"></div>${TOGGLE_SCRIPT}
<script>window.addEventListener("scroll", () => document.getElementById("panel").classList.remove("open"));</script></body></html>`;

    it("Passes when every item is on the screen, because such an item needs no scrolling", async () => {
      const links = [1, 2, 3, 4, 5].map((number) => `<a href="/one">Item ${number}</a>`).join("");
      const { thumb } = await reviewPages({ "/": dropdown(links), ...ROUTES });

      expect(thumb.notApplicable).toBeUndefined();
      expect(thumb.failures).toEqual([]);
    });

    it("says an item past the screen cannot be reached, rather than tapping a corner of the page", async () => {
      const links = `<a href="/one">Near</a><a href="/two" style="margin-top: 1200px">Far</a>`;
      const { thumb } = await reviewPages({ "/": dropdown(links), ...ROUTES });

      expect(thumb.failures.map((failure) => failure.location)).toEqual(['/ at "Far"']);
      expect(thumb.failures[0]!.reason).toMatch(/off the screen/i);
    });
  });

  it("does not leave the page or need the item's address to answer", async () => {
    const page = panelPage("").replace(`<a href="/two">Two</a>`, `<a href="#top">Two</a><a href="https://unreachable.invalid/" target="_blank">Three</a><a href="mailto:hello@example.com">Four</a>`);
    const { thumb } = await reviewPages({ "/": page, ...ROUTES });

    expect(thumb.notApplicable).toBeUndefined();
    expect(thumb.failures).toEqual([]);
  });
});

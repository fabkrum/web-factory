import type { Locator, Page } from "playwright";
import { goTo, movedOn, PageError, settled } from "./browser.ts";
import type { Failure, ReviewCheck, Route } from "./check.ts";

/** A phone Visitor's screen: touch, and the page laid out by its own viewport tag. */
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** What can open a menu: real controls, and the bare elements a hamburger icon is often built from. */
const TOGGLES = `button, summary, label[for], [role="button"], [aria-expanded], [aria-controls], [popovertarget], [class~="hamburger" i], [class~="burger" i], [class*="menu-toggle" i], [class*="nav-toggle" i]`;

/** How long an opening menu gets to show all its links, and how long they must stay the same to count as open. */
const OPEN_TIMEOUT = 1_000;
const OPEN_QUIET = 300;

/** How long a tap gets to reach anything, and how often a moving target is measured until it holds still. */
const TAP_TIMEOUT = 2_000;
const MEASURES = 40;
const MEASURE_EVERY = 50;

const NO_MENU =
  "This Site has no phone menu: at phone width no button in its header, and no button named as a menu, opens a list of links. Links that are simply on the page have nothing to fall through.";

/**
 * Opens the Site's menu at phone width and taps every item with a real touch,
 * on every route, because what lets a tap through can sit on one page only. The
 * tap is stopped as it arrives, so the review reads which element it reached
 * without leaving the page: an item's address, dead or external, does not matter.
 */
export const thumbCheck: ReviewCheck = {
  id: "accessibility/thumb-test",
  name: "Phone menu tapped at phone width",
  area: "Accessibility",
  async run(site) {
    const failures: Failure[] = [];
    let found = false;
    for (const route of site.routes) {
      if (route.problem) {
        failures.push({ reason: route.problem, location: route.path });
        continue;
      }
      const context = await site.browser.newContext(PHONE);
      try {
        const onRoute = await tapMenu(await context.newPage(), route);
        if (!onRoute) continue;
        found = true;
        failures.push(...onRoute);
      } catch (error) {
        if (!(error instanceof PageError)) throw error;
        failures.push({ reason: error.message, location: route.path });
      } finally {
        await context.close();
      }
    }
    return found || failures.length > 0 ? failures : { notApplicable: NO_MENU };
  },
};

/** What the phone menu of one route does when tapped; undefined when the route has none. */
async function tapMenu(page: Page, route: Route): Promise<Failure[] | undefined> {
  const menu = await openMenu(page, route);
  if (!menu) return undefined;
  if (menu.items.length === 0) {
    return [
      {
        reason:
          "Tapping this menu button at phone width shows no links, so a Visitor on a phone cannot get anywhere with it. Check that it opens the menu, and that nothing lies on top of it.",
        location: `${route.path} at "${await nameOf(toggleAt(page, menu.toggle))}"`,
      },
    ];
  }
  const failures: Failure[] = [];
  for (const item of menu.items) {
    // A page may close its menu on the touch itself, before the tap is stopped.
    if (!(await scan(page)).links.includes(item)) await openWith(page, route, menu.toggle);
    const failure = await tapItem(page, linkAt(page, item));
    if (failure) failures.push({ reason: failure.reason, location: `${route.path} at "${failure.name}"` });
  }
  return failures;
}

interface Menu {
  /** Which of the page's toggles opened it. */
  toggle: number;
  /** The links it showed, by their place among the page's links; none when a control named as a menu opened nothing. */
  items: number[];
}

/**
 * Tries the page's toggles until one shows links. Most are not menus: a search
 * button shows a form, a Sign up button leaves the page, and each is undone by
 * loading the page again.
 */
async function openMenu(page: Page, route: Route): Promise<Menu | undefined> {
  await goTo(page, route.address);
  const { toggles } = await settled(page, () => scan(page));
  for (const [place, toggle] of toggles.entries()) {
    if (place > 0) await load(page, route);
    const items = await tapToggle(page, toggle.index);
    if (items && (items.length > 0 || toggle.named)) return { toggle: toggle.index, items };
  }
  return undefined;
}

async function load(page: Page, route: Route): Promise<void> {
  await goTo(page, route.address);
  await settled(page, () => scan(page));
}

async function openWith(page: Page, route: Route, toggle: number): Promise<void> {
  await load(page, route);
  await tapToggle(page, toggle);
}

/** Taps a toggle and returns the links it showed, or undefined when it took the browser to another page. */
async function tapToggle(page: Page, toggle: number): Promise<number[] | undefined> {
  const address = page.url();
  try {
    const before = new Set((await scan(page)).links);
    const { x, y } = await holdStill(toggleAt(page, toggle));
    await page.touchscreen.tap(x, y);
    const started = Date.now();
    let items: number[] = [];
    let changed = started;
    while (Date.now() - started < OPEN_TIMEOUT) {
      await page.waitForTimeout(MEASURE_EVERY);
      if (page.url() !== address) return undefined;
      const now = (await scan(page)).links.filter((link) => !before.has(link));
      if (now.length !== items.length) changed = Date.now();
      items = now;
      if (items.length > 0 && Date.now() - changed >= OPEN_QUIET) break;
    }
    return items;
  } catch (error) {
    if (movedOn(error)) return undefined;
    throw error;
  }
}

/** One tap on a menu item: why it failed, or undefined when the item took it. */
async function tapItem(page: Page, item: Locator): Promise<{ name: string; reason: string } | undefined> {
  const name = await nameOf(item);
  const { x, y, onScreen } = await holdStill(item);
  if (!onScreen) {
    return {
      name,
      reason:
        "This menu item lies off the screen at phone width, and the menu does not scroll to it, so a Visitor on a phone cannot tap it. Let the open menu scroll (overflow-y: auto), or make it shorter.",
    };
  }
  // Wrapped in an object so that this returns once the listener is in place, not when the tap arrives.
  const listening = await item.evaluateHandle(
    (element, timeout) => ({
      tap: new Promise<{ took: boolean; landed: string } | null>((resolve) => {
        const listener = (event: Event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          clearTimeout(timer);
          const target = event.target as Element;
          const tag = target.outerHTML.slice(0, target.outerHTML.indexOf(">") + 1);
          resolve({ took: element.contains(target), landed: tag.length > 100 ? `${tag.slice(0, 99)}…` : tag });
        };
        const timer = setTimeout(() => {
          window.removeEventListener("click", listener, true);
          resolve(null);
        }, timeout);
        window.addEventListener("click", listener, { capture: true, once: true });
      }),
    }),
    TAP_TIMEOUT,
  );
  await page.touchscreen.tap(x, y);
  const tap = await listening.evaluate((waiting) => waiting.tap);
  if (tap?.took) return undefined;
  if (!tap) {
    return { name, reason: "Tapping this menu item at phone width does nothing: no element answers the tap, so a Visitor on a phone cannot follow it." };
  }
  return {
    name,
    reason: `This menu item looks tappable at phone width, but the tap goes past it to the page behind: it lands on ${tap.landed}. A Visitor taps the menu and gets something else. Keep the open menu above the page (z-index) and let it take taps (no pointer-events: none on it).`,
  };
}

function toggleAt(page: Page, index: number): Locator {
  return page.locator(TOGGLES).nth(index);
}

function linkAt(page: Page, index: number): Locator {
  return page.locator("a[href]").nth(index);
}

/** What a Builder calls this control or link. */
function nameOf(target: Locator): Promise<string> {
  return target.evaluate((element) => (element.textContent?.trim() || element.getAttribute("aria-label") || element.getAttribute("href") || element.tagName.toLowerCase()).slice(0, 60));
}

/** Where to touch the target once it stopped moving, after scrolling it into view. */
async function holdStill(target: Locator): Promise<{ x: number; y: number; onScreen: boolean }> {
  let last = await spot(target);
  for (let measure = 0; measure < MEASURES; measure++) {
    await target.page().waitForTimeout(MEASURE_EVERY);
    const now = await spot(target);
    if (now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  return last;
}

function spot(target: Locator): Promise<{ x: number; y: number; onScreen: boolean }> {
  return target.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = element.getClientRects()[0] ?? element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return { x, y, onScreen: x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight };
  });
}

interface Scan {
  /** The links a Visitor can see or scroll to now, by their place among the page's links. */
  links: number[];
  /** The toggles a Visitor can see: named as a menu first, then in the order of the page. */
  toggles: { index: number; named: boolean }[];
}

/** Reads the page as a Visitor sees it: a link slid off to the side or folded to no height is not there yet. */
function scan(page: Page): Promise<Scan> {
  return page.evaluate((selector) => {
    const clips = (style: CSSStyleDeclaration) => style.overflowX !== "visible" || style.overflowY !== "visible";
    const shown = (element: Element) => {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.right <= 0 || box.left >= window.innerWidth || box.bottom <= 0) return false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (!clips(getComputedStyle(parent))) continue;
        const clip = parent.getBoundingClientRect();
        if (box.right <= clip.left || box.left >= clip.right || box.bottom <= clip.top || box.top >= clip.bottom) return false;
      }
      return true;
    };
    // A control that calls itself a menu, by its words or its code name, in the languages a Builder is likely to write in.
    const named = (element: Element) =>
      /men[uüú]|\bnav|burger/i.test(
        [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), element.id, element.getAttribute("class"), element.getAttribute("aria-controls")].join(" "),
      );
    const toggles = [...document.querySelectorAll(selector)].flatMap((element, index) => {
      if (!shown(element)) return [];
      const isNamed = named(element);
      return isNamed || element.closest('header, nav, [role="banner"], [role="navigation"]') ? [{ index, named: isNamed }] : [];
    });
    return {
      links: [...document.querySelectorAll("a[href]")].flatMap((link, index) => (shown(link) ? [index] : [])),
      toggles: [...toggles.filter((toggle) => toggle.named), ...toggles.filter((toggle) => !toggle.named)],
    };
  }, TOGGLES);
}

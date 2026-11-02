import type { BrowserContext, ElementHandle, JSHandle, Page, Request } from "playwright";
import { goTo, movedOn, PageError, settled, whileHere } from "./browser.ts";
import type { Failure, ReviewCheck, Route } from "./check.ts";

/** A phone Visitor's screen: touch, and the page laid out by its own viewport tag. */
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** What can open a menu: real controls, and the bare elements a hamburger icon is often built from. */
const TOGGLES = `button, summary, label[for], [role="button"], [aria-expanded], [aria-controls], [popovertarget], [class~="hamburger" i], [class~="burger" i], [class*="menu-toggle" i], [class*="nav-toggle" i]`;

/** How long an opening menu gets to show all its links, however long it animates up to TAP_TIMEOUT, and how long they must stay the same to count as open. */
const OPEN_TIMEOUT = 1_000;
const OPEN_QUIET = 300;

/** How long a tap gets to reach anything, and how often a moving target is measured until it holds still. */
const TAP_TIMEOUT = 2_000;
/** How much longer than that a tap's answer may take to come back, and how long the touch or any other read of the page may: past that the page is on its way elsewhere or has frozen. */
const ANSWER_MARGIN = 1_000;
const READ_TIMEOUT = 5_000;
const MEASURES = 40;
const MEASURE_EVERY = 50;

/** Lets the hit test see what `pointer-events` hides from it. */
const ANY_POINTER = "* { pointer-events: auto !important; }";

const NO_MENU =
  "This Site has no phone menu: at phone width no button in its header, and no button named as a menu, opens a list of links. Links that are simply on the page have nothing to fall through.";

const MOVED_ON =
  "This page sent the browser on to another page by itself while its phone menu was being tapped, so the review could not finish tapping it. Check that the page holds still once it has loaded.";

/**
 * Opens the Site's menu at phone width and taps every item with a real touch,
 * on every route, because what lets a tap through can sit on one page only. The
 * tap is stopped as it arrives, so the review reads which element it reached and
 * an item's address, dead or external, does not matter. A page can still leave on
 * the touch itself, before the tap arrives; the next item then gets a new page,
 * and no read or touch waits for the page it left for, which may never answer, or
 * for a page frozen by its own script.
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
        const onRoute = await tapMenu(context, route);
        if (!onRoute) continue;
        found = true;
        failures.push(...onRoute);
      } catch (error) {
        if (error instanceof PageError) failures.push({ reason: error.message, location: route.path });
        else if (movedOn(error)) failures.push({ reason: MOVED_ON, location: route.path });
        else throw error;
      } finally {
        await context.close();
      }
    }
    return found || failures.length > 0 ? failures : { notApplicable: NO_MENU };
  },
};

/** What the phone menu of one route does when tapped; undefined when the route has none. */
async function tapMenu(context: BrowserContext, route: Route): Promise<Failure[] | undefined> {
  const menu = await openMenu(context, route);
  if (!menu) return undefined;
  const names = await Promise.all(menu.items.map(nameOf));
  const failures: Failure[] = [];
  let open: Menu | undefined = menu;
  let left = false;
  for (const [place, name] of names.entries()) {
    for (let again = false; ; again = true) {
      // A page may close its menu on the touch, before the tap is stopped, or be on its way elsewhere; stillOpen sees both.
      if (open && (left || !(await stillOpen(open, place)))) {
        open = await openAt(context, route, menu.place);
        left = false;
      }
      const item = open?.items[place];
      if (!open || !item) {
        failures.push({
          reason: "This menu item was gone when the menu was opened a second time, so a Visitor on a phone cannot count on it. Make the menu show the same links each time it opens.",
          location: `${route.path} at "${name}"`,
        });
        break;
      }
      try {
        const tap = await tapItem(open.page, item, open.items);
        left = tap.left;
        if (tap.failure) failures.push({ reason: tap.failure.reason, location: `${route.path} at "${tap.failure.name}"` });
        break;
      } catch (error) {
        // The page left before this item was touched, which the tap before it may have started. A new page has no such excuse.
        if (again || !movedOn(error)) throw error;
        left = true;
      }
    }
  }
  return failures;
}

/** An open menu. Its elements hold only until the page loads again. */
interface Menu {
  page: Page;
  /** Which of the page's toggles opened it, the one thing about it that outlasts a reload. */
  place: number;
  /** What the page showed before the tap, to tell the menu's links from the page's. */
  closed: Sights;
  /** The links it showed; none when the control opened nothing. */
  items: Control[];
}

/**
 * Tries the page's toggles until one shows links. Most are not menus: a search
 * button shows a form, a Sign up button leaves the page, and each is undone by
 * loading the page again. A control that shows no links counts as no menu, however
 * it is named, because no wording tells a dead menu button from "See our menu": this
 * check answers for taps that fall through, and a dead menu goes unreported by it.
 */
async function openMenu(context: BrowserContext, route: Route): Promise<Menu | undefined> {
  const page = await context.newPage();
  const { toggles } = await load(page, route);
  for (const [place, toggle] of toggles.entries()) {
    const menu = place === 0 ? await tapToggle(page, toggle, place) : await openAt(context, route, place);
    if (menu && menu.items.length > 0) return menu;
  }
  return undefined;
}

async function load(page: Page, route: Route): Promise<Scan> {
  await goTo(page, route.address);
  return settled(page, () => scan(page));
}

/**
 * Opens the menu on a new page, because a load on top of the old one would race
 * whatever trip it is still on, however slow. The old page is left to it and goes
 * with its context: closing a page just as it lands never returns.
 */
async function openAt(context: BrowserContext, route: Route, place: number): Promise<Menu | undefined> {
  const page = await context.newPage();
  const toggle = (await load(page, route)).toggles[place];
  return toggle && tapToggle(page, toggle, place);
}

/** Whether a link of the open menu still shows, compared with the page before the menu opened. Asked once the link holds still: a closing menu shows its links until its animation ends. */
async function stillOpen(menu: Menu, place: number): Promise<boolean> {
  const item = menu.items[place];
  if (!item) return false;
  try {
    await holdStill(menu.page, item);
    const { links } = await scan(menu.page, menu.closed);
    return await whileHere(
      menu.page.evaluate(({ links, item }) => links.includes(item), { links, item }),
      READ_TIMEOUT,
    );
  } catch (error) {
    if (movedOn(error)) return false;
    throw error;
  }
}

/** Taps a toggle and returns what it opened, or undefined when it took the browser to another page or froze this one. */
async function tapToggle(page: Page, toggle: Control, place: number): Promise<Menu | undefined> {
  const address = page.url();
  try {
    const { x, y } = await holdStill(page, toggle);
    // Read after holdStill: scrolling to the toggle moves the page's own links too.
    const { sights: closed } = await scan(page);
    await whileHere(page.touchscreen.tap(x, y), READ_TIMEOUT);
    const started = Date.now();
    let items: Control[] = [];
    let changed = started;
    while (Date.now() - started < TAP_TIMEOUT) {
      await page.waitForTimeout(MEASURE_EVERY);
      if (page.url() !== address) return undefined;
      const { links, moving } = await scan(page, closed);
      if (links.length !== items.length) changed = Date.now();
      items = links;
      if (items.length > 0 && !moving && Date.now() - changed >= OPEN_QUIET) break;
      if (!moving && Date.now() - started >= OPEN_TIMEOUT) break;
    }
    return { page, place, closed, items };
  } catch (error) {
    if (movedOn(error)) return undefined;
    throw error;
  }
}

/**
 * One tap on a menu item: why it failed, if it did, and whether the page set off
 * for another page. The tap counts as taken when it lands on the item, or on the
 * menu lying over it: a page link that came into sight while the menu opened, such
 * as a carousel's next slide, is read as an item, and the menu covers it. A tap
 * that lands under the item fell through, whatever it lands on.
 */
async function tapItem(page: Page, item: Control, items: Control[]): Promise<{ failure?: { name: string; reason: string }; left: boolean }> {
  const name = await nameOf(item);
  const { x, y, onScreen } = await holdStill(page, item);
  if (!onScreen) {
    return {
      left: false,
      failure: {
        name,
        reason:
          "This menu item lies off the screen at phone width, and the menu does not scroll to it, so a Visitor on a phone cannot tap it. Let the open menu scroll (overflow-y: auto), or make it shorter.",
      },
    };
  }
  // Wrapped in an object so that this returns once the listener is in place, not when the tap arrives.
  const listen = item.evaluateHandle(
    (element, { x, y, timeout, items, anyPointer }) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(anyPointer);
      const sheets = [...document.adoptedStyleSheets];
      document.adoptedStyleSheets = [...sheets, sheet];
      const stack = document.elementsFromPoint(x, y);
      document.adoptedStyleSheets = sheets;
      const above = stack.slice(0, Math.max(stack.findIndex((hit) => element.contains(hit)), 0));
      const ofMenu = (target: Element) => above.includes(target) && items.some((other) => other.contains(target) || target.contains(other));
      const landing = (target: Element): Landing => {
        const tag = target.outerHTML.slice(0, target.outerHTML.indexOf(">") + 1);
        return { took: element.contains(target) || ofMenu(target), landed: tag.length > 100 ? `${tag.slice(0, 99)}…` : tag };
      };
      return {
        aimed: landing(document.elementFromPoint(x, y) ?? document.documentElement),
        tap: new Promise<Landing | null>((resolve) => {
          const listener = (event: Event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            clearTimeout(timer);
            resolve(landing(event.target as Element));
          };
          const timer = setTimeout(() => {
            window.removeEventListener("click", listener, true);
            resolve(null);
          }, timeout);
          window.addEventListener("click", listener, { capture: true, once: true });
        }),
      };
    },
    { x, y, timeout: TAP_TIMEOUT, items, anyPointer: ANY_POINTER },
  );
  const listening = await whileHere(listen, READ_TIMEOUT);
  // Asked before the touch: a page that leaves on the touch takes the answer of the click with it.
  const aimed = await whileHere(
    listening.evaluate((waiting) => waiting.aimed),
    READ_TIMEOUT,
  );
  let setOff = false;
  const onRequest = (request: Request) => {
    setOff ||= sendsOff(page, request);
  };
  page.on("request", onRequest);
  const tap = await tapped(page, x, y, listening);
  page.off("request", onRequest);
  const left = tap === "left" || setOff;
  const landing = tap === "left" || (!tap && left) ? aimed : tap;
  if (landing?.took) return { left };
  if (!landing) {
    return { left, failure: { name, reason: "Tapping this menu item at phone width does nothing: no element answers the tap, so a Visitor on a phone cannot follow it." } };
  }
  return {
    left,
    failure: {
      name,
      reason: `This menu item looks tappable at phone width, but the tap goes past it to the page behind: it lands on ${landing.landed}. A Visitor taps the menu and gets something else. Keep the open menu above the page (z-index) and let it take taps (no pointer-events: none on it).`,
    },
  };
}

/** Whether this request takes the page itself elsewhere. An iframe's first request has no frame to ask yet. */
function sendsOff(page: Page, request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

/** Touches the spot and reads where the tap landed: null when no click came, "left" when the page went away or froze first. */
async function tapped(page: Page, x: number, y: number, listening: JSHandle<{ tap: Promise<Landing | null> }>): Promise<Landing | null | "left"> {
  try {
    await whileHere(page.touchscreen.tap(x, y), READ_TIMEOUT);
    return await whileHere(
      listening.evaluate((waiting) => waiting.tap),
      TAP_TIMEOUT + ANSWER_MARGIN,
    );
  } catch (error) {
    if (movedOn(error)) return "left";
    throw error;
  }
}

/** Where a tap arrived: whether the item got it, and the tag of what did. */
interface Landing {
  took: boolean;
  landed: string;
}

/** What a Builder calls this control or link. */
function nameOf(target: Control): Promise<string> {
  return whileHere(
    target.evaluate((element) => (element.textContent?.trim() || element.getAttribute("aria-label") || element.getAttribute("href") || element.tagName.toLowerCase()).slice(0, 60)),
    READ_TIMEOUT,
  );
}

/** Where to touch the target once it holds its place and nothing animates it any more, after scrolling it into view if it is not in view or lies under something. */
async function holdStill(page: Page, target: Control): Promise<Spot> {
  let last = await spot(target);
  for (let measure = 0; measure < MEASURES; measure++) {
    await page.waitForTimeout(MEASURE_EVERY);
    const now = await spot(target);
    if (now.x === last.x && now.y === last.y && !now.moving) return now;
    last = now;
  }
  return last;
}

function spot(target: Control): Promise<Spot> {
  return whileHere(
    target.evaluate((element) => {
      // A link wrapping a block starts with an empty line box.
      const place = () => [...element.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0) ?? element.getBoundingClientRect();
      const middle = () => {
        const box = place();
        return { box, x: box.left + box.width / 2, y: box.top + box.height / 2 };
      };
      const covered = () => {
        const { x, y } = middle();
        const hit = document.elementFromPoint(x, y);
        return !hit || !element.contains(hit);
      };
      // "nearest" leaves what is in view alone, and a page may close its menu on any scroll. What did need moving, or lies under a bar, goes to the middle, clear of what is fixed to the screen's edges.
      const { top, left } = place();
      element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      if (place().top !== top || place().left !== left || covered()) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const { box, x, y } = middle();
      // An animation that never ends is decoration: waiting for it would only use up the time.
      const moving = document.getAnimations().some((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        return animation.playState === "running" && effect?.target?.contains(element) === true && effect.getTiming().iterations !== Infinity;
      });
      // An empty box is an item the scroll closed away: there is nothing to touch at (0, 0).
      const shown = box.width > 0 && box.height > 0;
      return { x, y, onScreen: shown && x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight, moving };
    }),
    READ_TIMEOUT,
  );
}

interface Spot {
  x: number;
  y: number;
  onScreen: boolean;
  /** An animation on the target or around it is still running, so what shows there can still change. */
  moving: boolean;
}

/** An element of the page itself, held directly: a position among the page's elements shifts when a menu is inserted. */
type Control = ElementHandle<Element>;

/** How far in sight each of the page's links is, as `scan` measures it. */
type Sights = JSHandle<Map<Element, number>>;

interface Scan {
  /** The links a Visitor can see or scroll to now; with `before`, only those more in sight than they were then. */
  links: Control[];
  sights: Sights;
  /** An animation with an end is running on the page, so more links may be on their way. */
  moving: boolean;
  /** The toggles a Visitor can see: named as a menu first, then in the order of the page. */
  toggles: Control[];
}

/**
 * Reads the page as a Visitor sees it, asking the browser what lies at each link
 * rather than reading the CSS that put it there. The links that came further into
 * sight are what a tap opened.
 *
 * 0: not there. Hidden, off to the side or above the screen, cut away by an
 * ancestor it is positioned in, or clipped so that nothing of it lies at its own spot.
 * 1: there, but no tap reaches it now. Below the screen, which is a closed bottom
 * sheet or the rest of the page, or lying under something else.
 * 2: on top at its own spot.
 *
 * The hit test ignores `pointer-events`, and an open menu under a see-through layer
 * still comes up from 0 to 1, so a menu that lets taps fall through counts as opened:
 * that is the defect this check is for, and tapping it is what finds it. A link past
 * the fold of a scrolling list is as far in sight as the list, which shows it on a
 * scroll, so it is tapped like the rest.
 */
function scan(page: Page, before?: Sights): Promise<Scan> {
  return whileHere(readPage(page, before), READ_TIMEOUT);
}

async function readPage(page: Page, before?: Sights): Promise<Scan> {
  const found = await page.evaluateHandle(
    ({ selector, before, anyPointer }) => {
      const hides = (overflow: string) => overflow === "hidden" || overflow === "clip";
      const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
      const holdsFixed = (style: CSSStyleDeclaration) =>
        [style.transform, style.translate, style.rotate, style.scale, style.perspective, style.filter, style.backdropFilter].some((value) => value !== "none") ||
        /paint|layout|strict|content/.test(style.contain) ||
        /transform|translate|rotate|scale|perspective|filter/.test(style.willChange);
      const holds = (style: CSSStyleDeclaration, position: string) => {
        if (position === "fixed") return holdsFixed(style);
        return position !== "absolute" || style.position !== "static" || holdsFixed(style);
      };
      const sight = (element: Element): number => {
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return 0;
        const box = [...element.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0) ?? element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || box.right <= 0 || box.left >= window.innerWidth || box.bottom <= 0) return 0;
        let [left, right, top, bottom] = [box.left, box.right, box.top, box.bottom];
        let { position } = getComputedStyle(element);
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          // What is positioned past an ancestor is not clipped by it, even when it lies in it in the page's code.
          if (!holds(style, position)) continue;
          position = style.position;
          const { overflowX, overflowY } = style;
          if (overflowX === "visible" && overflowY === "visible") continue;
          const clip = parent.getBoundingClientRect();
          [left, right, top, bottom] = [Math.max(left, clip.left), Math.min(right, clip.right), Math.max(top, clip.top), Math.min(bottom, clip.bottom)];
          if (left < right && top < bottom) continue;
          if (scrolls(overflowX) || scrolls(overflowY)) return sight(parent);
          if (hides(overflowX) || hides(overflowY)) return 0;
        }
        if (top >= window.innerHeight) return 1;
        const x = (Math.max(left, 0) + Math.min(right, window.innerWidth)) / 2;
        const y = (Math.max(top, 0) + Math.min(bottom, window.innerHeight)) / 2;
        const stack = document.elementsFromPoint(x, y);
        if (!stack.some((hit) => element.contains(hit))) return 0;
        return stack[0] && element.contains(stack[0]) ? 2 : 1;
      };
      // Whether a control calls itself a menu, in the languages a Builder is likely to write in.
      const menuWord = /men[uüú](?!\p{L})|(?<!\p{L})nav(?:igation|egaci[oó]n)?(?!\p{L})/iu;
      const menuCode = /^(?:(?:main|mobile|site|primary|header|top|nav|hamburger)[-_]*)?(?:menu|nav|navbar|navigation|burger|hamburger)(?:[-_]*(?:toggle|toggler|button|btn|icon|trigger|open|opener))?$/i;
      const named = (element: Element) =>
        [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].some((label) => menuWord.test(label?.trim() ?? "")) ||
        [element.id, ...element.classList, ...(element.getAttribute("aria-controls") ?? "").split(/\s+/)].some((code) => menuCode.test(code));
      const onBar = (element: Element) => element.closest('header, nav, [role="banner"], [role="navigation"]') !== null;
      const anyPointerSheet = new CSSStyleSheet();
      anyPointerSheet.replaceSync(anyPointer);
      const sheets = [...document.adoptedStyleSheets];
      document.adoptedStyleSheets = [...sheets, anyPointerSheet];
      const toggles = [...document.querySelectorAll(selector)].filter((element) => sight(element) === 2);
      const sights = new Map([...document.querySelectorAll("a[href]")].map((link) => [link, sight(link)]));
      document.adoptedStyleSheets = sheets;
      const moving = document.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
      return {
        moving,
        links: [...sights].flatMap(([link, now]) => (now > (before?.get(link) ?? 0) ? [link] : [])),
        sights,
        toggles: [...toggles.filter(named), ...toggles.filter((element) => !named(element) && onBar(element))],
      };
    },
    { selector: TOGGLES, before, anyPointer: ANY_POINTER },
  );
  return {
    links: await elementsOf(await found.getProperty("links")),
    sights: await found.getProperty("sights"),
    moving: await found.evaluate((read) => read.moving),
    toggles: await elementsOf(await found.getProperty("toggles")),
  };
}

async function elementsOf(list: JSHandle<Element[]>): Promise<Control[]> {
  const properties = await list.getProperties();
  return [...properties.values()].flatMap((property) => (property.asElement() as Control | null) ?? []);
}

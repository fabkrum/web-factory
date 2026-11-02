import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Board, Card } from "../src/board.ts";
import { renderBoard } from "../src/board-page.ts";
import { factory } from "../src/cli.ts";
import { launchBrowser } from "../src/review/browser.ts";
import type { ReviewReport } from "../src/review/review.ts";
import { STAGES } from "../src/stages.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo } from "./harness/site-repo.ts";


const emptySite = () => mkdtempSync(join(tmpdir(), "web-factory-board-"));

async function boardOf(cwd: string, tracker: FakeTracker, clock?: FakeClock): Promise<Board> {
  const run = await runFactory(["board", "--json"], { cwd, tracker, clock });
  expect(run.exitCode, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Board;
}

function cardIn(board: Board, stage: string, number: number): Card {
  const card = board.columns.find((column) => column.stage === stage)?.cards.find((candidate) => candidate.number === number);
  if (!card) throw new Error(`#${number} is not in the ${stage} column`);
  return card;
}

const failsCanonical = async (url: URL): Promise<ReviewReport> => ({
  url: url.href,
  routes: ["/"],
  passed: false,
  areas: [
    {
      area: "Visibility",
      checks: [{ id: "canonical", name: "Canonical URLs", passed: false, failures: [{ reason: "This page names no canonical address.", location: "/" }] }],
    },
  ],
} as ReviewReport);

describe("the board's data", () => {
  it("has one column per Stage, Decision stages and Automatic stages told apart", async () => {
    const board = await boardOf(emptySite(), new FakeTracker());

    expect(board.columns.map((column) => column.stage)).toEqual([...STAGES]);
    expect(board.columns.filter((column) => column.kind === "decision").map((column) => column.stage)).toEqual(["request", "spec", "design", "approve"]);
    expect(board.columns.filter((column) => column.kind === "automatic").map((column) => column.stage)).toEqual(["build", "review", "publish", "measure"]);
  });

  it("puts every open Request and Ticket in the column of its Stage label, and nothing closed", async () => {
    const tracker = new FakeTracker();
    const request = await tracker.createIssue({ title: "A contact form", body: "", stage: "request" });
    const spec = tracker.addSpec("A greeting page");
    const inSpec = tracker.addTicket(spec, "Waits for the cut", "", ["stage:spec"]);
    const inBuild = tracker.addTicket(spec, "Say hello");
    const oddCase = tracker.addTicket(spec, "Label in other letter case", "", ["Stage:Review"]);
    const closed = tracker.addTicket(spec, "Done already");
    tracker.closeByHand(closed);

    const board = await boardOf(emptySite(), tracker);

    expect(cardIn(board, "request", request).title).toBe("A contact form");
    expect(board.columns.find((column) => column.stage === "spec")?.cards.map((card) => card.number)).toEqual([spec, inSpec]);
    expect(cardIn(board, "build", inBuild).spec).toBe(spec);
    expect(cardIn(board, "review", oddCase).title).toBe("Label in other letter case");
    expect(board.columns.flatMap((column) => column.cards).map((card) => card.number)).not.toContain(closed);
    for (const card of board.columns.flatMap((column) => column.cards)) expect(card.nextAction).not.toBe("");
  });

  it("names an open issue without a Stage label instead of dropping it", async () => {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A Spec");
    const stray = tracker.addTicket(spec, "Filed by hand", "", []);

    expect((await boardOf(emptySite(), tracker)).withoutStage.map((issue) => issue.number)).toEqual([stray]);
  });

  it("shows a parked Ticket's attempts, failing Review check, reason and next action", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 2 });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    const work = ({ cwd }: { cwd: string }) => void commitFile(cwd, `work-${Date.now()}-${Math.random()}.txt`, "work\n");
    const agentCli = new FakeAgentCli(work, work);
    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite: failsCanonical });

    const card = cardIn(await boardOf(site, tracker), "build", ticket);

    expect(card).toMatchObject({ status: "parked", attempts: 2, failingChecks: ["Canonical URLs"] });
    expect(card.reason).toMatch(/no canonical address/);
    expect(card.nextAction).toBe(`Answer in a comment on Ticket #${ticket}, then run: factory loop ${spec}`);
  });

  it("tells the Builder to run the loop again once they answered a parked Ticket", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    await runFactory(["loop", String(spec)], {
      cwd: site,
      agentCli: new FakeAgentCli(() => ({ kind: "decision" as const, question: "Blue or green?" })),
      tracker,
    });
    const asked = cardIn(await boardOf(site, tracker), "build", ticket);
    expect(asked).toMatchObject({ status: "parked", attempts: 1, failingChecks: [] });
    expect(asked.reason).toMatch(/Blue or green\?/);

    await tracker.comment(ticket, "Green.");

    expect(cardIn(await boardOf(site, tracker), "build", ticket).nextAction).toMatch(new RegExp(`run the Ticket loop again: factory loop ${spec}`));
  });

  it("shows the attempts of a Ticket parked on another machine, for each way of parking", async () => {
    const parkedAfterAttempts = async (cli: FakeAgentCli, maxAttempts: number) => {
      const tracker = new FakeTracker();
      const spec = tracker.addSpec("A greeting page");
      const ticket = tracker.addTicket(spec, "Say hello");
      await runFactory(["loop", String(spec)], { cwd: createSiteRepo({ testCommand: "true", maxAttempts }), agentCli: cli, tracker, reviewSite: failsCanonical });
      return cardIn(await boardOf(emptySite(), tracker), "build", ticket);
    };
    const work = ({ cwd }: { cwd: string }) => void commitFile(cwd, `work-${Date.now()}-${Math.random()}.txt`, "work\n");
    const ask = () => ({ kind: "decision" as const, question: "Blue or green?" });

    const limit = await parkedAfterAttempts(new FakeAgentCli(work, work), 2);
    expect(limit).toMatchObject({ status: "parked", attempts: 2 });
    expect(limit.reason).toMatch(/tried this Ticket 2 times/);
    expect(limit.reason).not.toMatch(/factory attempts/);

    const decision = await parkedAfterAttempts(new FakeAgentCli(work, ask), 3);
    expect(decision).toMatchObject({ status: "parked", attempts: 2 });
    expect(decision.reason).not.toMatch(/factory attempts/);
  });

  it("states no number for a parked Ticket whose comment carries no count", async () => {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    await tracker.comment(ticket, "Parked. Written by hand.");

    const board = await boardOf(emptySite(), tracker);

    expect(cardIn(board, "build", ticket).attempts).toBeUndefined();
    const page = renderBoard(board, new Date(0));
    expect(page).toContain(`#${ticket}</a> Say hello</h3>\n<p class="meta">Attempts not known here: parked on another machine</p>`);
  });

  it("finds a parked Ticket on GitHub when this machine has no local state for it", async () => {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    await tracker.comment(ticket, "Parked. The Ticket loop tried this Ticket 3 times and it did not pass.");

    const card = cardIn(await boardOf(emptySite(), tracker), "build", ticket);

    expect(card.status).toBe("parked");
    expect(card.reason).toMatch(/tried this Ticket 3 times/);
    expect(card.nextAction).toMatch(/^Answer in a comment/);
  });

  it("shows a Ticket waiting on a rate limit as waiting, with its resume time", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    const clock = new FakeClock();
    const resumeAt = new Date(clock.now().getTime() + 2 * 60 * 60 * 1000);
    let during: Card | undefined;
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms) => {
      during = cardIn(await boardOf(site, tracker, clock), "build", ticket);
      await sleep(ms);
    };
    const agentCli = new FakeAgentCli(() => ({ kind: "rate-limited" as const, until: resumeAt }), ({ cwd }) => void commitFile(cwd, "index.html", "hello\n"));

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock });

    expect(during).toMatchObject({ status: "waiting", attempts: 1, resumeAt: resumeAt.toISOString(), nextAction: "Nothing to do: the Ticket loop resumes by itself." });
  });

  it("says so when a rate limit's resume time passed and the Ticket still waits", async () => {
    const site = emptySite();
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    const clock = new FakeClock();
    mkdirSync(join(site, ".factory"));
    writeFileSync(join(site, ".factory", `spec-${spec}.json`), JSON.stringify({ tickets: { [ticket]: { status: "waiting", attempts: 1, reason: "Rate limit.", resumeAt: new Date(clock.now().getTime() - 1000).toISOString() } } }));

    expect(cardIn(await boardOf(site, tracker, clock), "build", ticket).nextAction).toBe(`It should have resumed by now. If the Ticket loop stopped, run: factory loop ${spec}`);
  });

  it("keeps the failing Review check on the card during the fix round", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    let during: Card | undefined;
    const agentCli = new FakeAgentCli(
      ({ cwd }) => void commitFile(cwd, "one.txt", "one\n"),
      async () => {
        during = cardIn(await boardOf(site, tracker), "build", ticket);
        return { kind: "decision" as const, question: "Stop here." };
      },
    );

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite: failsCanonical });

    expect(during).toMatchObject({ status: "building", attempts: 2, failingChecks: ["Canonical URLs"] });
  });

  it("still opens when a local state file is broken", async () => {
    const site = emptySite();
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    mkdirSync(join(site, ".factory"));
    writeFileSync(join(site, ".factory", `spec-${spec}.json`), "{ not json");

    expect(cardIn(await boardOf(site, tracker), "build", ticket).attempts).toBe(0);
  });

  it("asks for a GitHub login when nobody is logged in", async () => {
    const tracker = new FakeTracker();
    tracker.loggedOut = true;

    const run = await runFactory(["board", "--json"], { cwd: emptySite(), tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/gh auth login/);
  });

  it("refuses a port that is no port", async () => {
    const run = await runFactory(["board", "--port", "seventy"], { cwd: emptySite(), tracker: new FakeTracker() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/--port/);
  });
});

/** Runs `factory board` until `work` is done, with the address it printed. */
async function withBoard(tracker: FakeTracker, env: NodeJS.ProcessEnv, work: (url: string, stdout: string) => Promise<void>, opened: string[] = [], args = ["--port", "0"]) {
  const stop = new AbortController();
  let stdout = "";
  let stderr = "";
  let printed: (url: string) => void;
  const address = new Promise<string>((resolve) => (printed = resolve));
  const running = factory(["board", ...args], {
    cwd: emptySite(),
    tracker,
    clock: new FakeClock(),
    env,
    stop: stop.signal,
    openBrowser: (url) => opened.push(url),
    stdout: (text) => {
      stdout += text;
      const found = /open at (\S+)/.exec(text)?.[1];
      if (found) printed(found);
    },
    stderr: (text) => void (stderr += text),
  });
  const url = await Promise.race([address, running.then((code) => Promise.reject(new Error(`board ended with ${code}: ${stderr}`)))]);
  try {
    await work(url, stdout);
  } finally {
    stop.abort();
    expect(await running).toBe(0);
  }
}

describe("the board page", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  function busyTracker() {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    tracker.addTicket(spec, "<script>window.hacked = true</script> A very long Ticket title that has to wrap on a phone without pushing the page sideways");
    return tracker;
  }

  it("opens the browser at the address it prints, and escapes what issues say", async () => {
    const opened: string[] = [];
    await withBoard(
      busyTracker(),
      {},
      async (url) => {
        const page = await browser.newPage();
        await page.goto(url);
        expect(await page.evaluate(() => "hacked" in window)).toBe(false);
        expect(await page.locator('[data-stage="build"] h3').first().textContent()).toContain("<script>");
        expect((await page.request.get(new URL("/other", url).href)).status()).toBe(404);
        await page.close();
      },
      opened,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  it("reloads by itself, but not while the Builder reads a whole reason", async () => {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    await tracker.comment(ticket, "Parked. First line.\nThe second line.");
    await withBoard(tracker, {}, async (url) => {
      const page = await browser.newPage();
      await page.clock.install();
      await page.goto(url);
      let loads = 0;
      page.on("load", () => loads++);
      await page.locator("summary").click();
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      await page.clock.runFor(61_000);
      expect(loads).toBe(0);

      await page.locator("summary").click();
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      const reloaded = page.waitForEvent("load");
      await page.clock.runFor(31_000);
      await reloaded;
      await page.close();
    });
  });

  it("colours Decision stage columns blue and Automatic stage columns green", async () => {
    await withBoard(busyTracker(), {}, async (url) => {
      const page = await browser.newPage();
      await page.goto(url);
      const colours = await page.$$eval("[data-stage]", (columns) =>
        columns.map((column) => [column.getAttribute("data-stage"), getComputedStyle(column.querySelector("header")!).backgroundColor]),
      );
      await page.close();
      for (const [stage, colour] of colours) {
        const [red, green, blue] = colour!.match(/\d+/g)!.map(Number) as [number, number, number];
        if (["request", "spec", "design", "approve"].includes(stage!)) expect(blue, stage!).toBeGreaterThan(Math.max(red, green));
        else expect(green, stage!).toBeGreaterThan(Math.max(red, blue));
      }
    });
  });

  for (const colorScheme of ["light", "dark"] as const) {
    it(`is readable at phone width in the ${colorScheme} colour scheme`, async () => {
      await withBoard(busyTracker(), {}, async (url) => {
        const context = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme });
        const page = await context.newPage();
        await page.goto(url);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.addScriptTag({ path: createRequire(import.meta.url).resolve("axe-core/axe.min.js") });
        const violations = await page.evaluate(async () => {
          const { violations } = await (window as unknown as { axe: { run(): Promise<{ violations: { id: string }[] }> } }).axe.run();
          return violations.map((violation) => violation.id);
        });
        expect(violations).toEqual([]);
        await context.close();
      });
    });
  }

  it("prints the forwarded address in a Codespace and leaves the browser to it", async () => {
    const opened: string[] = [];
    const env = { CODESPACES: "true", CODESPACE_NAME: "happy-site", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" };
    const stop = new AbortController();
    let stdout = "";
    const running = factory(["board", "--port", "0"], {
      cwd: emptySite(),
      tracker: new FakeTracker(),
      clock: new FakeClock(),
      env,
      stop: stop.signal,
      openBrowser: (url) => opened.push(url),
      stdout: (text) => {
        stdout += text;
        stop.abort();
      },
      stderr: () => {},
    });

    expect(await running).toBe(0);
    expect(stdout).toMatch(/https:\/\/happy-site-\d+\.app\.github\.dev\//);
    expect(opened).toEqual([]);
  });

  it("says plainly when its port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as { port: number };

    const run = await runFactory(["board", "--port", String(port)], { cwd: emptySite(), tracker: new FakeTracker() });
    await new Promise((resolve) => blocker.close(resolve));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`Port ${port} is already in use`));
  });

  it("says so on the page when GitHub stops answering, and keeps running", async () => {
    const tracker = busyTracker();
    await withBoard(tracker, {}, async (url) => {
      tracker.loggedOut = true;
      const page = await browser.newPage();
      const response = await page.goto(url);
      expect(response?.status()).toBe(503);
      expect(await page.textContent("main")).toMatch(/GitHub could not be reached/);
      await page.close();
    });
  });
});

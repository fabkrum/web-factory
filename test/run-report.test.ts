import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Board } from "../src/board.ts";
import { renderBoard } from "../src/board-page.ts";
import { duration, readRunReports, type RunReport } from "../src/run-report.ts";
import type { ReviewReport } from "../src/review/review.ts";
import type { Tracker } from "../src/tracker.ts";
import { FakeAgentCli, requestsChanges, type ScriptedSession } from "./harness/fake-agent-cli.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { delegateTo, FakeTracker } from "./harness/fake-tracker.ts";
import { FakeHost } from "./harness/fake-host.ts";
import { everyCheckPasses, runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo } from "./harness/site-repo.ts";

const TWO_HOURS = 2 * 60 * 60 * 1000;
const QUESTION = "Should the greeting be in German or in English?";

const builds =
  (name: string, content = "work\n"): ScriptedSession =>
  ({ cwd }) =>
    void commitFile(cwd, name, content);

/** Red once, the first time it runs on work that holds flaky.txt; red whenever a page says broken. */
function testCommand(): string {
  const once = join(mkdtempSync(join(tmpdir(), "web-factory-flaky-")), "ran-once");
  return `if [ -f flaky.txt ] && [ ! -f ${once} ]; then touch ${once}; echo timing out; exit 1; fi; ! grep -qs broken page.txt`;
}

const failsCanonicalOn = (file: string) => async (url: URL, repo: string): Promise<ReviewReport> => {
  const failing = readdirSync(repo).includes(file) && !readdirSync(repo).includes("fixed.txt");
  if (!failing) return everyCheckPasses(url, repo);
  return {
    url: url.href,
    routes: ["/"],
    passed: false,
    areas: [{ area: "Visibility", checks: [{ id: "canonical", name: "Canonical URLs", passed: false, failures: [{ reason: "This page names no canonical address.", location: "/" }] }] }],
  } as ReviewReport;
};

/** Five Tickets, one for each thing a Run report tells apart. */
async function eventfulRun() {
  const site = createSiteRepo({ testCommand: testCommand(), maxAttempts: 2 });
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A greeting page");
  const straight = tracker.addTicket(spec, "Straight through");
  const fixed = tracker.addTicket(spec, "Needs a fix round");
  const parked = tracker.addTicket(spec, "Asks a decision");
  const flaky = tracker.addTicket(spec, "Meets a flaky test");
  const limited = tracker.addTicket(spec, "Meets a rate limit");
  const clock = new FakeClock();
  const agentCli = new FakeAgentCli(
    builds("straight.txt"),
    builds("canonical.txt"),
    builds("fixed.txt"),
    () => ({ kind: "decision", question: QUESTION }),
    builds("flaky.txt"),
    () => ({ kind: "rate-limited", until: new Date(clock.now().getTime() + TWO_HOURS) }),
    builds("limited.txt"),
  );
  const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock, reviewSite: failsCanonicalOn("canonical.txt") });
  return { site, tracker, clock, spec, run, tickets: { straight, fixed, parked, flaky, limited } };
}

function stored(site: string): Promise<RunReport[]> {
  return readRunReports(join(site, ".factory"));
}

async function boardOf(cwd: string, tracker: FakeTracker): Promise<Board> {
  const run = await runFactory(["board", "--json"], { cwd, tracker });
  expect(run.exitCode, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Board;
}

describe("the Run report after a run", () => {
  it("tells a Pass, a fix round, a park, a flaky rerun and a rate-limit wait apart in a comment on the Spec", async () => {
    const { tracker, spec, run, tickets } = await eventfulRun();

    expect(run.exitCode).not.toBe(0);
    const comments = tracker.issue(spec).comments;
    expect(comments).toHaveLength(1);
    const comment = comments[0]!;
    expect(comment).toMatch(/^Run report of the Ticket loop\. 5 Tickets: 3 straight through, 1 passed after fix rounds, 1 parked, waited 2 hours on rate limits\./);
    expect(comment).toMatch(new RegExp(`Went straight through:\\n- #${tickets.straight} Straight through\\n- #${tickets.flaky} Meets a flaky test\\n- #${tickets.limited} Meets a rate limit`));
    expect(comment).toMatch(new RegExp(`Needed fix rounds:\\n- #${tickets.fixed} Needs a fix round: 1 fix round, then it passed\\.\\n  - Attempt 1 did not pass \\(failing: Canonical URLs\\): The Review check "Canonical URLs" failed: - /: This page names no canonical address\\.`));
    expect(comment).toMatch(new RegExp(`Parked, waiting for you:\\n- #${tickets.parked} Asks a decision: .*${QUESTION}`));
    expect(comment).toMatch(new RegExp(`Flaky tests:\\n- #${tickets.flaky} Meets a flaky test: the tests were red, then green on the rerun`));
    expect(comment).toMatch(new RegExp(`Waited on rate limits for 2 hours:\\n- #${tickets.limited} Meets a rate limit: 2 hours`));
    expect(comment).toMatch(new RegExp(`Review checks that failed:\\n- Canonical URLs: #${tickets.fixed}`));
  });

  it("stores the run in a form Measure can read: the numbers, not only the words", async () => {
    const { site, spec, clock, tickets } = await eventfulRun();

    const [report, ...others] = await stored(site);

    expect(others).toEqual([]);
    expect(report).toMatchObject({
      version: 1,
      spec,
      run: 1,
      startedAt: "2026-10-22T22:00:00.000Z",
      finishedAt: clock.now().toISOString(),
      rateLimitWaitMs: TWO_HOURS,
    });
    const of = (ticket: number) => report!.tickets.find((entry) => entry.ticket === ticket);
    expect(of(tickets.straight)).toMatchObject({ outcome: "passed", attempts: 1, fixRounds: 0, failedAttempts: [], flaky: [], rateLimitWaitMs: 0 });
    expect(of(tickets.fixed)).toMatchObject({ outcome: "passed", attempts: 2, fixRounds: 1, failedAttempts: [{ attempt: 1, failingChecks: ["Canonical URLs"] }] });
    expect(of(tickets.parked)).toMatchObject({ outcome: "parked", attempts: 1, fixRounds: 0, reason: expect.stringContaining(QUESTION) });
    expect(of(tickets.flaky)).toMatchObject({ outcome: "passed", attempts: 1, flaky: [expect.stringContaining("timing out")] });
    expect(of(tickets.limited)).toMatchObject({ outcome: "passed", attempts: 1, rateLimitWaitMs: TWO_HOURS });
  });

  it("keeps every run of every Spec, oldest first, so Measure reads across runs", async () => {
    const { site, tracker, spec, tickets } = await eventfulRun();
    await tracker.comment(tickets.parked, "In English, please.");
    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(builds("parked.txt")), tracker });
    const other = tracker.addSpec("Another page");
    tracker.addTicket(other, "Its page");
    await runFactory(["loop", String(other)], { cwd: site, agentCli: new FakeAgentCli(builds("other.txt")), tracker });

    const reports = await stored(site);

    expect(reports.map(({ spec: number, run }) => [number, run])).toEqual([[spec, 1], [spec, 2], [other, 1]]);
    expect(reports[1]?.tickets.map((ticket) => [ticket.ticket, ticket.outcome])).toEqual([[tickets.parked, "passed"]]);
    expect(tracker.issue(spec).comments).toHaveLength(2);
  });

  it("names the pull request once every Ticket is done", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    tracker.addTicket(spec, "Say hello");
    const host = new FakeHost();

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(builds("hello.txt")), tracker, host });

    const [report] = await stored(site);
    const pullRequest = tracker.pullRequests[0]!;
    expect(report?.pullRequest).toEqual({ number: pullRequest.number, url: pullRequest.url, preview: host.previews[0]?.url });
    expect(tracker.issue(spec).comments[0]).toContain(`pull request #${pullRequest.number}`);
    expect(tracker.issue(spec).comments[0]).toContain(host.previews[0]?.url);
  });

  it("reports a Ticket that is still parked, and one waiting for it, without counting an attempt", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const first = tracker.addTicket(spec, "Asks a decision");
    const second = tracker.addTicket(spec, "Builds on the first");
    tracker.block(second, { by: first });
    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(() => ({ kind: "decision", question: QUESTION })), tracker });

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker });

    const report = (await stored(site)).at(-1);
    expect(report?.tickets).toMatchObject([
      { ticket: first, outcome: "parked", attempts: 0, reason: expect.stringContaining(QUESTION) },
      { ticket: second, outcome: "blocked", attempts: 0, reason: expect.stringContaining(`#${first}`) },
    ]);
    expect(tracker.issue(spec).comments.at(-1)).toMatch(/Not started:\n.*It waits for/);
  });

  it("still reports a run that stops early, with the reason and the Ticket it stopped on", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    const agentCli = new FakeAgentCli(() => {
      throw new Error("The disk is full");
    });

    await expect(runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker })).rejects.toThrow("The disk is full");

    const [report] = await stored(site);
    expect(report).toMatchObject({ stopped: "The disk is full", tickets: [{ ticket, outcome: "unfinished", attempts: 1 }] });
    expect(tracker.issue(spec).comments[0]).toMatch(/1 unfinished[\s\S]*stopped before it was through: The disk is full/);
  });

  it("does not change how a run ended when the comment cannot be posted, and keeps the report", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const fake = new FakeTracker();
    const spec = fake.addSpec("A greeting page");
    fake.addTicket(spec, "Say hello");
    const tracker: Tracker = {
      ...delegateTo(fake),
      comment: async (issue, body) => {
        if (issue === spec) throw new Error("GitHub is down");
        await fake.comment(issue, body);
      },
    };

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(builds("hello.txt")), tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Run report could not be put on Spec.*GitHub is down/);
    expect(await stored(site)).toHaveLength(1);
  });

  it("writes none when there was nothing to build", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    tracker.addTicket(spec, "Waits for the Design", "", ["stage:design"]);

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker });

    expect(await stored(site)).toEqual([]);
    expect(tracker.issue(spec).comments).toEqual([]);
  });

  it("counts a Ticket the code review sent back, whose Review checks all passed", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    tracker.addTicket(spec, "Say hello");
    const agentCli = new FakeAgentCli(builds("one.txt"), builds("two.txt")).reviewing(requestsChanges([{ text: "Name the page" }]));

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(tracker.issue(spec).comments[0]).toMatch(/Attempt 1 did not pass: The code review sent this Ticket back:/);
    expect(tracker.issue(spec).comments[0]).not.toContain("Review checks that failed");
  });
});

describe("the flaky rerun", () => {
  it("counts red then green as a Pass, says so on the Ticket and keeps what the red run said", async () => {
    const { site, spec, tracker, tickets, run } = await eventfulRun();

    expect(tracker.issue(tickets.flaky).state).toBe("closed");
    expect(tracker.issue(tickets.flaky).comments[0]).toMatch(/^Pass\..*flaky/);
    expect(run.stdout).toMatch(/recorded as flaky/);
    const state = JSON.parse(readFileSync(join(site, ".factory", `spec-${spec}.json`), "utf8"));
    expect(state.tickets[String(tickets.flaky)]).toMatchObject({ status: "passed", attempts: 1, flaky: expect.stringContaining("timing out") });
  });

  it("does not Pass tests that are red on the rerun too", async () => {
    const site = createSiteRepo({ testCommand: "! grep -qs broken page.txt", maxAttempts: 1 });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(builds("page.txt", "broken\n")), tracker });

    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments[0]).toMatch(/red again on the rerun/);
    expect((await stored(site))[0]?.tickets[0]?.flaky).toEqual([]);
  });
});

describe("the board", () => {
  it("shows the latest Run report of each Spec in plain words, also on the page", async () => {
    const { site, tracker, spec, tickets } = await eventfulRun();
    await tracker.comment(tickets.parked, "In English, please.");
    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(builds("parked.txt")), tracker });
    const other = tracker.addSpec("Another <page>");
    tracker.addTicket(other, "Its page");
    await runFactory(["loop", String(other)], { cwd: site, agentCli: new FakeAgentCli(builds("other.txt")), tracker });

    const board = await boardOf(site, tracker);

    expect(board.runReports.map((report) => report.spec)).toEqual([other, spec]);
    const latest = board.runReports[1]!;
    expect(latest.summary).toBe("1 Ticket: 1 straight through.");
    expect(latest.details).toContain(`#${tickets.parked} Asks a decision`);
    expect(latest.details).not.toContain("Canonical URLs");

    const page = renderBoard(board, new Date());
    expect(page).toContain("Latest Run reports");
    expect(page).toContain("1 Ticket: 1 straight through.");
    expect(page).toContain("Another &lt;page&gt;");
  });

  it("shows a Spec's report after the Spec is closed, and passes over a file it cannot read", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    tracker.addTicket(spec, "Say hello");
    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(builds("hello.txt")), tracker });
    tracker.closeByHand(spec);
    mkdirSync(join(site, ".factory", "run-reports"), { recursive: true });
    writeFileSync(join(site, ".factory", "run-reports", "spec-999-run-1.json"), "not json");

    const board = await boardOf(site, tracker);

    expect(board.runReports).toMatchObject([{ spec, summary: "1 Ticket: 1 straight through." }]);
    expect(board.runReports[0]?.title).toBeUndefined();
    expect(renderBoard(board, new Date())).toContain(`Spec #${spec}`);
  });

  it("shows no reports section before the first run", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const board = await boardOf(site, new FakeTracker());

    expect(board.runReports).toEqual([]);
    expect(renderBoard(board, new Date())).not.toContain("Run reports");
  });
});

describe("a wait in plain words", () => {
  it("reads in hours and minutes, a part of a minute counting as a whole one", () => {
    expect(duration(60_000)).toBe("1 minute");
    expect(duration(61_000)).toBe("2 minutes");
    expect(duration(TWO_HOURS)).toBe("2 hours");
    expect(duration(TWO_HOURS + 5 * 60_000)).toBe("2 hours 5 minutes");
  });
});

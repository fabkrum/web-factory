import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo } from "./harness/site-repo.ts";

const TEST_COMMAND = "grep -q hello index.html";
const RED = /test command `grep -q hello index\.html` is red/;
const TWO_HOURS = 2 * 60 * 60 * 1000;

function oneTicketSpec() {
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A greeting page");
  const ticket = tracker.addTicket(spec, "Say hello on the home page", "The home page says hello.");
  return { tracker, spec, ticket };
}

const sayGoodbye = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", "<h1>goodbye</h1>\n");
const sayHello = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", "<h1>hello</h1>\n");
const rateLimitedFor = (clock: FakeClock, ms: number) => () => ({ kind: "rate-limited" as const, until: new Date(clock.now().getTime() + ms) });

function boardState(site: string, spec: number, ticket: number): { status: string; attempts: number; reason?: string } {
  const state = JSON.parse(readFileSync(join(site, ".factory", `spec-${spec}.json`), "utf8"));
  return state.tickets[String(ticket)];
}

describe("rate limits", () => {
  it("waits until the reported time and resumes the same Ticket, which then Passes", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const clock = new FakeClock();
    const agentCli = new FakeAgentCli(rateLimitedFor(clock, TWO_HOURS), sayHello);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(clock.sleeps).toEqual([TWO_HOURS]);
    expect(run.stdout).toMatch(/rate limit/);
    expect(agentCli.sessions).toHaveLength(2);
    expect(agentCli.sessions[1]?.cwd).toBe(agentCli.sessions[0]?.cwd);
    expect(agentCli.sessions[1]?.prompt).toBe(agentCli.sessions[0]?.prompt);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "passed", attempts: 1 });
  });

  it("does not count the paused attempt towards the attempt limit", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 2 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const clock = new FakeClock();
    const agentCli = new FakeAgentCli(sayGoodbye, rateLimitedFor(clock, TWO_HOURS), rateLimitedFor(clock, TWO_HOURS), sayHello);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(clock.sleeps).toEqual([TWO_HOURS, TWO_HOURS]);
    expect(agentCli.sessions).toHaveLength(4);
    // The resumed fix round still carries the reason the attempt before failed.
    expect(agentCli.sessions[3]?.prompt).toMatch(RED);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "passed", attempts: 2 });
  });

  it("waits a minute before trying again when the reported time has already passed", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec } = oneTicketSpec();
    const clock = new FakeClock();
    const agentCli = new FakeAgentCli(rateLimitedFor(clock, -1000), sayHello);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(clock.sleeps).toEqual([60 * 1000]);
  });

  it("shows the Ticket as waiting on the rate limit on the board while it waits", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const clock = new FakeClock();
    let duringWait: ReturnType<typeof boardState> | undefined;
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms) => {
      duringWait = boardState(site, spec, ticket);
      await sleep(ms);
    };
    const agentCli = new FakeAgentCli(rateLimitedFor(clock, TWO_HOURS), sayHello);

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock });

    expect(duringWait).toMatchObject({ status: "waiting", attempts: 1, reason: expect.stringMatching(/rate limit/) });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo } from "./harness/site-repo.ts";

/** The Site's tests are green when the Ticket's page says hello. */
const TEST_COMMAND = "grep -q hello index.html";
const RED = /test command `grep -q hello index\.html` is red/;
const QUESTION = "Should the greeting be in German or in English?";

function oneTicketSpec() {
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A greeting page");
  const ticket = tracker.addTicket(spec, "Say hello on the home page", "The home page says hello.");
  return { tracker, spec, ticket };
}

let goodbyes = 0;
const sayGoodbye = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", `<h1>goodbye ${++goodbyes}</h1>\n`);
const sayHello = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", "<h1>hello</h1>\n");
const askDecision = () => ({ kind: "decision" as const, question: QUESTION });

/** What the board reads: the loop's local state for one Ticket. */
function boardState(site: string, spec: number, ticket: number): { status: string; attempts: number; reason?: string } {
  const state = JSON.parse(readFileSync(join(site, ".factory", `spec-${spec}.json`), "utf8"));
  return state.tickets[String(ticket)];
}

function lastComment(tracker: FakeTracker, ticket: number): string {
  return tracker.issue(ticket).comments.at(-1) ?? "";
}

describe("fix rounds", () => {
  it("sends a failing Ticket back to Build with the failing reason in its prompt, and Passes it on the fix round", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(sayGoodbye, sayHello);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(agentCli.sessions).toHaveLength(2);
    expect(agentCli.sessions[0]?.prompt).not.toMatch(RED);
    expect(agentCli.sessions[1]?.prompt).toMatch(RED);
    expect(agentCli.sessions[1]?.cwd).toBe(agentCli.sessions[0]?.cwd);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "passed", attempts: 2 });
  });
});

describe("parking", () => {
  it("parks a Ticket after three failed attempts by default: open, in its Stage, with the reason in plain words", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(sayGoodbye, sayGoodbye, sayGoodbye);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toMatch(new RegExp(`Parked.*#${ticket}`));
    expect(agentCli.sessions).toHaveLength(3);
    const issue = tracker.issue(ticket);
    expect(issue.state).toBe("open");
    expect(issue.labels).toEqual(["stage:build"]);
    expect(issue.comments).toHaveLength(1);
    expect(lastComment(tracker, ticket)).toMatch(/^Parked\./);
    expect(lastComment(tracker, ticket)).toMatch(/3 times/);
    expect(lastComment(tracker, ticket)).toMatch(RED);
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "parked", attempts: 3, reason: expect.stringMatching(RED) });
  });

  it("parks after the attempt limit the Site sets", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 2 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(sayGoodbye, sayGoodbye);

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(agentCli.sessions).toHaveLength(2);
    expect(lastComment(tracker, ticket)).toMatch(/^Parked\./);
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "parked", attempts: 2 });
  });

  it("refuses an attempt limit below one", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 0 });
    const { tracker, spec } = oneTicketSpec();

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/maxAttempts/);
  });

  it("parks at once when a session asks for a decision, with the question on the Ticket", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(askDecision);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode).not.toBe(0);
    expect(agentCli.sessions).toHaveLength(1);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(lastComment(tracker, ticket)).toMatch(/^Parked\./);
    expect(lastComment(tracker, ticket)).toContain(QUESTION);
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "parked", attempts: 1, reason: expect.stringContaining(QUESTION) });
  });

  it("leaves a parked Ticket alone until the Builder answers on it, then builds it with the answer in every round", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(askDecision), tracker });

    const waiting = new FakeAgentCli();
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: waiting, tracker });

    expect(waiting.sessions).toHaveLength(0);
    expect(rerun.exitCode).not.toBe(0);
    expect(rerun.stdout).toMatch(new RegExp(`Parked.*#${ticket}`));
    expect(tracker.issue(ticket).comments).toHaveLength(1);
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "parked" });

    await tracker.comment(ticket, "In English, please.");
    const answered = new FakeAgentCli(sayGoodbye, sayHello);
    const afterAnswer = await runFactory(["loop", String(spec)], { cwd: site, agentCli: answered, tracker });

    expect(afterAnswer.exitCode, afterAnswer.stderr).toBe(0);
    expect(answered.sessions[0]?.prompt).toContain(QUESTION);
    expect(answered.sessions[0]?.prompt).toContain("In English, please.");
    expect(answered.sessions[1]?.prompt).toContain("In English, please.");
    expect(answered.sessions[1]?.prompt).toMatch(RED);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(boardState(site, spec, ticket)).toMatchObject({ status: "passed", attempts: 2 });
  });

  it("goes on building the other Tickets when one parks", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("Two pages");
    const first = tracker.addTicket(spec, "The first page");
    const second = tracker.addTicket(spec, "The second page");
    const agentCli = new FakeAgentCli(askDecision, ({ cwd }) => void commitFile(cwd, "two.html", "<h1>two</h1>\n"));

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode).not.toBe(0);
    expect(tracker.issue(first).state).toBe("open");
    expect(lastComment(tracker, first)).toMatch(/^Parked\./);
    expect(tracker.issue(second).state).toBe("closed");
    expect(boardState(site, spec, first)).toMatchObject({ status: "parked" });
    expect(boardState(site, spec, second)).toMatchObject({ status: "passed" });
  });
});

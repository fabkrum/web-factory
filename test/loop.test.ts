import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Tracker } from "../src/tracker.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

/** The Site's tests are green when the Ticket's page says hello. */
const TEST_COMMAND = "grep -q hello index.html";

function oneTicketSpec() {
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A greeting page");
  const ticket = tracker.addTicket(spec, "Say hello on the home page", "The home page says hello.");
  return { tracker, spec, ticket };
}

describe("factory loop with one Ticket", () => {
  it("builds the Ticket in its own worktree, fast-forwards it into the Spec's integration branch and closes it as a Pass", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const mainBefore = git(site, "rev-parse", "main");
    const { tracker, spec, ticket } = oneTicketSpec();
    let sessionBranch = "";
    let ticketCommit = "";
    const agentCli = new FakeAgentCli(({ cwd }) => {
      sessionBranch = git(cwd, "branch", "--show-current");
      ticketCommit = commitFile(cwd, "index.html", "<h1>hello</h1>\n", "Say hello on the home page");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(tracker.issue(ticket).labels).toEqual(["stage:build"]);
    expect(tracker.issue(ticket).comments).toHaveLength(1);
    expect(tracker.issue(ticket).comments[0]).toMatch(/^Pass/);

    const [session] = agentCli.sessions;
    expect(session?.cwd).not.toBe(site);
    expect(sessionBranch).toBe(`ticket/${ticket}`);
    expect(session?.sandbox).toBe(true);

    expect(git(site, "rev-parse", "main")).toBe(mainBefore);
    expect(git(site, "branch", "--show-current")).toBe("main");
    expect(git(site, "status", "--porcelain")).toBe("");
    expect(existsSync(`${site}/index.html`)).toBe(false);

    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(ticketCommit);
  });

  it("does not Pass a Ticket whose session produced no commit", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(() => {});

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /no commit/i);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose session left the tree dirty", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
      writeFile(cwd, "notes.txt", "forgot to commit this\n");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /uncommitted/i);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose test command is red", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>goodbye</h1>\n");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /test command `grep -q hello index\.html` is red/i);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose test command leaves a file behind", async () => {
    const site = createSiteRepo({ testCommand: `${TEST_COMMAND} && touch report.txt` });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /report\.txt/);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose session committed on another branch", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      git(cwd, "checkout", "--quiet", "-b", "other");
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /not on `ticket\/\d+`/);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("finishes on the next run a Pass that broke off after the fast-forward", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND });
    const { tracker, spec, ticket } = oneTicketSpec();
    let ticketCommit = "";
    const agentCli = new FakeAgentCli(({ cwd }) => {
      ticketCommit = commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });
    const closeFails: Tracker = {
      ticketsOf: (n) => tracker.ticketsOf(n),
      comment: (n, body) => tracker.comment(n, body),
      close: async () => {
        throw new Error("GitHub is down");
      },
    };

    await expect(runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker: closeFails })).rejects.toThrow(/GitHub is down/);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(ticketCommit);
    expect(tracker.issue(ticket).state).toBe("open");

    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(tracker.issue(ticket).comments.every((comment) => /^Pass/.test(comment))).toBe(true);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(ticketCommit);
    expect(existsSync(`${site}/.factory/worktrees/ticket-${ticket}`)).toBe(false);
  });

  it("does not Pass a Ticket whose session failed", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
      return { kind: "failed", reason: "the session crashed" };
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /the session crashed/);
  });
});

function expectNoPass(exitCode: number, tracker: FakeTracker, ticket: number, reason: RegExp): void {
  expect(exitCode).not.toBe(0);
  const issue = tracker.issue(ticket);
  expect(issue.state).toBe("open");
  expect(issue.comments.some((comment) => /^Pass/.test(comment))).toBe(false);
  expect(issue.comments.join("\n")).toMatch(reason);
}

function expectIntegrationBranchUnchanged(site: string, spec: number): void {
  expect(git(site, "rev-parse", `spec/${spec}`)).toBe(git(site, "rev-parse", "main"));
}

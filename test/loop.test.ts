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
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(() => {});

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /no commit/i);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose session left the tree dirty", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
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
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>goodbye</h1>\n");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /test command `grep -q hello index\.html` is red/i);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose test command leaves a file behind", async () => {
    const site = createSiteRepo({ testCommand: `${TEST_COMMAND} && touch report.txt`, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /report\.txt/);
    expectIntegrationBranchUnchanged(site, spec);
  });

  it("does not Pass a Ticket whose session committed on another branch", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
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
      historyOf: (n) => tracker.historyOf(n),
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
    expect(tracker.issue(ticket).comments).toHaveLength(1);
    expect(tracker.issue(ticket).comments[0]).toMatch(/^Pass/);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(ticketCommit);
    expect(existsSync(`${site}/.factory/worktrees/ticket-${ticket}`)).toBe(false);
  });

  it("builds a reopened Ticket again when its last Pass closed it but reported an error", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const closesThenFails: Tracker = {
      ticketsOf: (n) => tracker.ticketsOf(n),
      historyOf: (n) => tracker.historyOf(n),
      comment: (n, body) => tracker.comment(n, body),
      close: async (n) => {
        await tracker.close(n);
        throw new Error("GitHub timed out");
      },
    };
    const first = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });

    await expect(runFactory(["loop", String(spec)], { cwd: site, agentCli: first, tracker: closesThenFails })).rejects.toThrow(/timed out/);
    expect(tracker.issue(ticket).state).toBe("closed");

    tracker.reopen(ticket);
    const rework = new FakeAgentCli(() => {});
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: rework, tracker });

    expect(rework.sessions).toHaveLength(1);
    expect(rerun.exitCode).not.toBe(0);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.filter((comment) => /^Pass/.test(comment))).toHaveLength(1);
  });

  it("only closes on the next run a Ticket whose Pass comment went through but reported an error, and builds it again once reopened", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    let ticketCommit = "";
    const first = new FakeAgentCli(({ cwd }) => {
      ticketCommit = commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });
    const commentsThenFails: Tracker = {
      ticketsOf: (n) => tracker.ticketsOf(n),
      historyOf: (n) => tracker.historyOf(n),
      comment: async (n, body) => {
        await tracker.comment(n, body);
        throw new Error("GitHub timed out");
      },
      close: (n) => tracker.close(n),
    };

    await expect(runFactory(["loop", String(spec)], { cwd: site, agentCli: first, tracker: commentsThenFails })).rejects.toThrow(/timed out/);
    expect(tracker.issue(ticket).state).toBe("open");

    const none = new FakeAgentCli();
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: none, tracker });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(none.sessions).toHaveLength(0);
    expect(tracker.issue(ticket).state).toBe("closed");
    expect(tracker.issue(ticket).comments).toHaveLength(1);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(ticketCommit);

    tracker.reopen(ticket);
    const rework = new FakeAgentCli(() => {});
    const afterReopen = await runFactory(["loop", String(spec)], { cwd: site, agentCli: rework, tracker });

    expect(rework.sessions).toHaveLength(1);
    expect(afterReopen.exitCode).not.toBe(0);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.filter((comment) => /^Pass/.test(comment))).toHaveLength(1);
  });

  it("does not finish a broken-off Pass whose Ticket was closed and reopened since, but builds it again", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const first = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
    });
    const commentsThenFails: Tracker = {
      ticketsOf: (n) => tracker.ticketsOf(n),
      historyOf: (n) => tracker.historyOf(n),
      comment: async (n, body) => {
        await tracker.comment(n, body);
        throw new Error("GitHub timed out");
      },
      close: (n) => tracker.close(n),
    };

    await expect(runFactory(["loop", String(spec)], { cwd: site, agentCli: first, tracker: commentsThenFails })).rejects.toThrow(/timed out/);
    await tracker.close(ticket);
    tracker.reopen(ticket);
    const rework = new FakeAgentCli(() => {});
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: rework, tracker });

    expect(rework.sessions).toHaveLength(1);
    expect(rerun.exitCode).not.toBe(0);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.filter((comment) => /^Pass/.test(comment))).toHaveLength(1);
  });

  it("does not Pass a Ticket whose session built on the base branch instead of the integration branch", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    git(site, "branch", `spec/${spec}`, "main");
    git(site, "checkout", "--quiet", `spec/${spec}`);
    commitFile(site, "about.html", "<h1>about</h1>\n", "An earlier Ticket");
    git(site, "checkout", "--quiet", "main");
    const integrationBefore = git(site, "rev-parse", `spec/${spec}`);
    const agentCli = new FakeAgentCli(
      ({ cwd }) => {
        git(cwd, "reset", "--quiet", "--hard", "main");
        commitFile(cwd, "index.html", "<h1>hello</h1>\n");
      },
      () => {},
    );

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /does not build on `spec\/\d+`/);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(integrationBefore);

    await tracker.comment(ticket, "Try again, please.");
    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });
    expect(agentCli.sessions).toHaveLength(2);
  });

  it("does not Pass a Ticket whose integration branch moved on during its session, and builds it again next run", async () => {
    const site = createSiteRepo({ testCommand: TEST_COMMAND, maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(
      ({ cwd }) => {
        commitFile(cwd, "index.html", "<h1>hello</h1>\n");
        const elsewhere = git(site, "commit-tree", "-p", `spec/${spec}`, "-m", "Something else", `spec/${spec}^{tree}`);
        git(site, "update-ref", `refs/heads/spec/${spec}`, elsewhere);
      },
      () => {},
    );

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /moved on/);

    await tracker.comment(ticket, "Try again, please.");
    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });
    expect(agentCli.sessions).toHaveLength(2);
  });

  it("does not Pass a Ticket whose session failed", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(({ cwd }) => {
      commitFile(cwd, "index.html", "<h1>hello</h1>\n");
      return { kind: "failed", reason: "the session crashed" };
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(run.exitCode, tracker, ticket, /the session crashed/);
  });
});

describe("factory loop with two Tickets", () => {
  function twoTicketSpec() {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("Two pages");
    const first = tracker.addTicket(spec, "The first page");
    const second = tracker.addTicket(spec, "The second page");
    return { tracker, spec, first, second };
  }

  it("brings a Ticket that did not pass up to what a sibling Passed since, so it can Pass on a later run", async () => {
    const site = createSiteRepo({ testCommand: "test ! -f broken.txt", maxAttempts: 1 });
    const { tracker, spec, first, second } = twoTicketSpec();
    let sawSibling = false;
    const agentCli = new FakeAgentCli(
      ({ cwd }) => {
        commitFile(cwd, "broken.txt", "red\n");
        commitFile(cwd, "one.html", "<h1>one</h1>\n");
      },
      ({ cwd }) => {
        commitFile(cwd, "two.html", "<h1>two</h1>\n");
      },
      ({ cwd, prompt }) => {
        sawSibling = existsSync(`${cwd}/two.html`);
        expect(prompt).toMatch(/build on `spec\/\d+`/);
        git(cwd, "rm", "-q", "broken.txt");
        git(cwd, "commit", "-q", "-m", "Fix the first page");
      },
    );

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });
    expect(run.exitCode).not.toBe(0);
    expect(tracker.issue(second).state).toBe("closed");

    await tracker.comment(first, "Try again, please.");
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(sawSibling).toBe(true);
    expect(tracker.issue(first).state).toBe("closed");
    expect(git(site, "show", `spec/${spec}:one.html`)).toBe("<h1>one</h1>");
    expect(git(site, "show", `spec/${spec}:two.html`)).toBe("<h1>two</h1>");
  });

  it("does not Pass a Ticket with no commit of its own on the catch-up with what a sibling Passed", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    git(site, "config", "merge.ff", "false");
    const { tracker, spec, first, second } = twoTicketSpec();
    const agentCli = new FakeAgentCli(
      () => {},
      ({ cwd }) => {
        commitFile(cwd, "two.html", "<h1>two</h1>\n");
      },
      () => {},
    );

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });
    expect(tracker.issue(second).state).toBe("closed");
    const integrationBefore = git(site, "rev-parse", `spec/${spec}`);

    await tracker.comment(first, "Try again, please.");
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expectNoPass(rerun.exitCode, tracker, first, /no commit/);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(integrationBefore);
    expect(git(site, "rev-list", "--merges", "--count", `spec/${spec}..ticket/${first}`)).toBe("0");
  });

  it("tells the session to resolve the conflicts when what a sibling Passed does not merge cleanly", async () => {
    const site = createSiteRepo({ testCommand: "grep -q both index.html", maxAttempts: 1 });
    const { tracker, spec, first, second } = twoTicketSpec();
    let catchUpPrompt = "";
    const agentCli = new FakeAgentCli(
      ({ cwd }) => {
        commitFile(cwd, "index.html", "<h1>one</h1>\n");
      },
      ({ cwd }) => {
        commitFile(cwd, "index.html", "<h1>both</h1>\n");
      },
      ({ cwd, prompt }) => {
        catchUpPrompt = prompt;
        writeFile(cwd, "index.html", "<h1>one</h1>\n<h1>both</h1>\n");
        git(cwd, "add", "index.html");
        git(cwd, "commit", "-q", "--no-edit");
      },
    );

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });
    expect(tracker.issue(second).state).toBe("closed");

    await tracker.comment(first, "Try again, please.");
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(catchUpPrompt).toMatch(/conflicts/);
    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(tracker.issue(first).state).toBe("closed");
    expect(git(site, "show", `spec/${spec}:index.html`)).toBe("<h1>one</h1>\n<h1>both</h1>");
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

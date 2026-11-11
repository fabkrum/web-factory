import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/agent-cli.ts";
import { HostError } from "../src/host.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeHost } from "./harness/fake-host.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, originBranch } from "./harness/site-repo.ts";

/** The Ticket whose worktree a session runs in, read from its branch. */
function ticketOf({ cwd }: Session): number {
  return Number(git(cwd, "branch", "--show-current").replace("ticket/", ""));
}

/** A session that builds whichever Ticket it is given: one page per Ticket. */
function buildsPage({ cwd }: Session): void {
  const ticket = git(cwd, "branch", "--show-current").replace("ticket/", "");
  commitFile(cwd, `ticket-${ticket}.html`, `<h1>Ticket ${ticket}</h1>\n`);
}

function loopState(site: string, spec: number) {
  return JSON.parse(readFileSync(`${site}/.factory/spec-${spec}.json`, "utf8")) as {
    tickets: Record<string, { status: string; reason?: string }>;
  };
}

describe("factory loop with several Tickets", () => {
  it("builds the lowest unblocked Ticket first and never starts a Ticket before its blockers Pass", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A small Site");
    const contact = tracker.addTicket(spec, "Contact page");
    const home = tracker.addTicket(spec, "Home page");
    const layout = tracker.addTicket(spec, "Shared layout");
    tracker.block(contact, { by: layout });
    const built: number[] = [];
    const blockersClosedAtStart: boolean[] = [];
    const session = (s: Session) => {
      const ticket = ticketOf(s);
      built.push(ticket);
      blockersClosedAtStart.push(tracker.issue(ticket).blockedBy.every((b) => tracker.issue(b).state === "closed"));
      if (ticket === contact) expect(existsSync(`${s.cwd}/ticket-${layout}.html`)).toBe(true);
      buildsPage(s);
    };
    const agentCli = new FakeAgentCli(session, session, session);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(built).toEqual([home, layout, contact]);
    expect(blockersClosedAtStart).toEqual([true, true, true]);
    for (const ticket of [contact, home, layout]) expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("leaves the dependants of a parked blocker unstarted, with that reason, and builds the rest", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A small Site");
    const layout = tracker.addTicket(spec, "Shared layout");
    const contact = tracker.addTicket(spec, "Contact page");
    const home = tracker.addTicket(spec, "Home page");
    tracker.block(contact, { by: layout });
    const host = new FakeHost();
    const built: number[] = [];
    const agentCli = new FakeAgentCli(
      (s) => {
        built.push(ticketOf(s));
        return { kind: "decision", question: "Which font should the layout use?" };
      },
      (s) => {
        built.push(ticketOf(s));
        buildsPage(s);
      },
    );

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, host });

    expect(run.exitCode).toBe(1);
    expect(built).toEqual([layout, home]);
    expect(tracker.issue(contact).state).toBe("open");
    expect(tracker.issue(contact).comments).toEqual([]);
    expect(git(site, "branch", "--list", `ticket/${contact}`)).toBe("");
    const blocked = loopState(site, spec).tickets[String(contact)];
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.reason).toMatch(new RegExp(`#${layout}.*parked`));
    expect(run.stdout).toMatch(new RegExp(`#${contact}.*#${layout}.*parked`));

    expect(tracker.pullRequests).toEqual([]);
    expect(host.previews).toEqual([]);
    expect(originBranch(site, `spec/${spec}`)).toBeUndefined();
  });

  it("leaves a Ticket unstarted while a blocker outside the Spec is open, and builds it once that is closed", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const other = tracker.addSpec("Another Spec");
    const spec = tracker.addSpec("A small Site");
    const ticket = tracker.addTicket(spec, "Home page");
    tracker.block(ticket, { by: other });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker });

    expect(run.exitCode).toBe(1);
    expect(loopState(site, spec).tickets[String(ticket)]?.reason).toMatch(new RegExp(`#${other}.*still open`));

    tracker.closeByHand(other);
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(tracker.issue(ticket).state).toBe("closed");
  });
});

describe("the finished Spec", () => {
  it("opens one pull request against main with the host's Preview URL, and never pushes to main", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const mainBefore = git(site, "rev-parse", "main");
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A small Site");
    const home = tracker.addTicket(spec, "Home page");
    const contact = tracker.addTicket(spec, "Contact page");
    const host = new FakeHost();

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage, buildsPage), tracker, host });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracker.pullRequests).toHaveLength(1);
    const [pr] = tracker.pullRequests;
    expect(pr?.head).toBe(`spec/${spec}`);
    expect(pr?.base).toBe("main");
    expect(pr?.title).toBe("A small Site");
    expect(host.previews.map((p) => p.branch)).toEqual([`spec/${spec}`]);
    expect(pr?.body).toContain(host.previews[0]?.url);
    expect(pr?.body).toContain(`#${home}`);
    expect(pr?.body).toContain(`#${contact}`);
    expect(run.stdout).toContain(pr?.url);
    expect(run.stdout).toContain(host.previews[0]?.url);

    expect(originBranch(site, `spec/${spec}`)).toBe(git(site, "rev-parse", `spec/${spec}`));
    expect(originBranch(site, "main")).toBe(mainBefore);
    expect(git(site, "rev-parse", "main")).toBe(mainBefore);

    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker, host });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(tracker.pullRequests).toHaveLength(1);
    expect(host.previews).toHaveLength(1);
    expect(originBranch(site, "main")).toBe(mainBefore);
  });

  it("stops with the host's reason when the Preview cannot be deployed, and a later run opens the pull request", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A small Site");
    tracker.addTicket(spec, "Home page");
    const host = new FakeHost();
    const deploy = host.deployPreview.bind(host);
    host.deployPreview = async () => {
      throw new HostError("Firebase refused the deploy.");
    };

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker, host });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Firebase refused the deploy/);
    expect(tracker.pullRequests).toEqual([]);

    host.deployPreview = deploy;
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker, host });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(tracker.pullRequests).toHaveLength(1);
  });

  it("opens the pull request on a later run when the run that finished the last Ticket could not push", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const origin = git(site, "remote", "get-url", "origin");
    git(site, "remote", "remove", "origin");
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A small Site");
    tracker.addTicket(spec, "Home page");

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/no remote called origin/);
    expect(tracker.pullRequests).toEqual([]);

    git(site, "remote", "add", "origin", origin);
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(tracker.pullRequests).toHaveLength(1);
  });
});

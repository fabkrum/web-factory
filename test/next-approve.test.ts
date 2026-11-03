import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/agent-cli.ts";
import { HostError } from "../src/host.ts";
import type { NextStep } from "../src/next.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { FakeHost } from "./harness/fake-host.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, originBranch, writeFile } from "./harness/site-repo.ts";

const TEMPLATE_AGENTS = readFileSync(resolve(import.meta.dirname, "..", "packages/create-web-factory/template/AGENTS.md"), "utf8");
const KICKED_OFF = "# Site\n\n## Stack\n\n- Stack: Astro\n";
const PARK_COMMENT = "Parked. The Ticket loop tried this Ticket 1 time and it did not pass.";

function kickedOffSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-factory-next-"));
  writeFile(dir, "AGENTS.md", KICKED_OFF);
  return dir;
}

async function next(tracker: FakeTracker, dir = kickedOffSite(), clock?: FakeClock): Promise<NextStep> {
  const run = await runFactory(["next", "--json"], { cwd: dir, tracker, clock });
  expect(run.exitCode, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as NextStep;
}

/** A session that builds whichever Ticket it is given. */
function buildsPage({ cwd }: Session): void {
  const ticket = git(cwd, "branch", "--show-current").replace("ticket/", "");
  commitFile(cwd, `ticket-${ticket}.html`, `<h1>Ticket ${ticket}</h1>\n`);
}

const inStage = (tracker: FakeTracker, stage: string, title = "A page"): number => {
  const spec = tracker.addSpec(title);
  tracker.issue(spec).labels = [`stage:${stage}`];
  return spec;
};

/** A site, whose Spec's Tickets all Passed, with its pull request open. */
async function specInApprove() {
  const site = createSiteRepo({ testCommand: "true" });
  const tracker = new FakeTracker();
  const host = new FakeHost();
  const spec = inStage(tracker, "build");
  tracker.addTicket(spec, "Home page");
  const built = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker, host });
  expect(built.exitCode, built.stderr).toBe(0);
  return { site, tracker, host, spec, pullRequest: tracker.pullRequests[0]! };
}

function change(site: string, overrides: Record<string, unknown> = {}): string {
  writeFile(site, ".git/change.json", JSON.stringify({ title: "Bigger headline", delivers: "A headline guests read from afar", acceptance: ["The headline fills the phone's width"], ...overrides }));
  return ".git/change.json";
}

describe("factory next", () => {
  it("sends a Site without a Kickoff to the kickoff skill, with no GitHub login yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-factory-next-"));
    writeFile(dir, "AGENTS.md", TEMPLATE_AGENTS);
    const tracker = new FakeTracker();
    tracker.loggedOut = true;

    expect(await next(tracker, dir)).toMatchObject({ skill: "kickoff" });
  });

  it("refuses a folder that is no Site, in plain words", async () => {
    const run = await runFactory(["next"], { cwd: mkdtempSync(join(tmpdir(), "web-factory-next-")), tracker: new FakeTracker() });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/not a Site/);
  });

  it("asks for the GitHub login once it has to read the board", async () => {
    const tracker = new FakeTracker();
    tracker.loggedOut = true;

    const run = await runFactory(["next"], { cwd: kickedOffSite(), tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/gh auth login/);
  });

  it("sends an empty board to the request skill", async () => {
    expect(await next(new FakeTracker())).toMatchObject({ skill: "request" });
  });

  it.each([
    ["request", "spec"],
    ["spec", "spec"],
    ["design", "design"],
    ["approve", "approve"],
  ])("sends a Spec in the %s Stage to the %s skill", async (stage, skill) => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, stage);

    expect(await next(tracker)).toMatchObject({ skill, issue: spec });
  });

  it("tells a Spec in Build to start the Ticket loop, by command, whether or not it has its Tickets on the board", async () => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, "build");

    expect(await next(tracker)).toEqual({ action: expect.stringContaining(`factory loop ${spec}`), issue: spec });

    const ticket = tracker.addTicket(spec, "Home page");

    expect(await next(tracker)).toEqual({ action: expect.stringContaining(`factory loop ${spec}`), issue: ticket });
  });

  it.each(["review", "publish", "measure"])("lets the %s Stage run by itself and sends the Builder to their next idea", async (stage) => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, stage);

    const step = await next(tracker);

    expect(step).toMatchObject({ skill: "request" });
    expect(step.action).toContain(`#${spec}`);
    expect(step.action).toContain(stage);
  });

  it("does not stop at Tickets that move on with their Spec", async () => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, "design");
    tracker.addTicket(spec, "Home page", "", ["stage:spec"]);

    expect(await next(tracker)).toMatchObject({ skill: "design", issue: spec });
  });

  it("names an issue without a Stage once nothing else asks for the Builder", async () => {
    const tracker = new FakeTracker();
    const stray = tracker.addTicket(tracker.addSpec("Done"), "Filed by hand", "", []);
    tracker.closeByHand(1);

    expect(await next(tracker)).toMatchObject({ skill: "request", issue: stray });

    inStage(tracker, "design");
    expect(await next(tracker)).toMatchObject({ skill: "design" });
  });

  it("for each Ticket loop state, names that state's action, with no skill", async () => {
    const local = (status: string, more = {}) => JSON.stringify({ tickets: { 2: { status, attempts: 1, reason: "A reason.", ...more } } });
    const clock = new FakeClock();
    const cases: [string, string, RegExp][] = [
      ["parked", local("parked"), /factory loop 1/],
      ["not-passed", local("not-passed"), /Read the reason/],
      ["blocked", local("blocked"), /until its blocker passes/],
      ["building", local("building"), /Nothing to do while the Ticket loop runs/],
      ["reviewing", local("reviewing"), /Nothing to do while the Ticket loop runs/],
      ["waiting", local("waiting", { resumeAt: new Date(clock.now().getTime() + 60_000).toISOString() }), /resumes by itself/],
      ["passed and reopened", local("passed"), /factory loop 1/],
    ];
    for (const [name, state, action] of cases) {
      const tracker = new FakeTracker();
      const spec = inStage(tracker, "build");
      const ticket = tracker.addTicket(spec, "Home page");
      const dir = kickedOffSite();
      writeFile(dir, ".factory/spec-1.json", state);

      const step = await next(tracker, dir, clock);

      expect(step.action, name).toMatch(action);
      expect(step, name).toMatchObject({ issue: ticket });
      expect(step.skill, name).toBeUndefined();
    }
  });

  it("picks one action from a full board: the work closest to the Visitor first, a running loop last", async () => {
    const tracker = new FakeTracker();
    const running = inStage(tracker, "build", "Building");
    const runningTicket = tracker.addTicket(running, "Runs");
    const request = await tracker.createIssue({ title: "An idea", body: "", stage: "request" });
    const specced = inStage(tracker, "spec");
    const designed = inStage(tracker, "design");
    const ready = inStage(tracker, "build", "Ready");
    const parkedSpec = inStage(tracker, "build", "Parked");
    const parked = tracker.addTicket(parkedSpec, "Asks");
    const approving = inStage(tracker, "approve");
    const dir = kickedOffSite();
    writeFile(dir, `.factory/spec-${running}.json`, JSON.stringify({ tickets: { [runningTicket]: { status: "building", attempts: 1 } } }));
    writeFile(dir, ".factory/spec-99.json", JSON.stringify({ tickets: { [parked]: { status: "parked", attempts: 3, reason: "Blue or green?" } } }));

    const order: (number | undefined)[] = [];
    for (const done of [approving, parked, ready, designed, specced, request, runningTicket]) {
      const step = await next(tracker, dir);
      order.push(step.issue);
      tracker.closeByHand(done);
      if (done === parked) tracker.closeByHand(parkedSpec);
    }

    expect(order).toEqual([approving, parked, ready, designed, specced, request, runningTicket]);
  });

  it.each([
    ["the lower Ticket", 0],
    ["the higher Ticket", 1],
  ])("names the running loop, never a second one, while %s is building and the other has not started", async (_, building) => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, "build");
    const tickets = [tracker.addTicket(spec, "Home page"), tracker.addTicket(spec, "About page")];
    const dir = kickedOffSite();
    writeFile(dir, `.factory/spec-${spec}.json`, JSON.stringify({ tickets: { [tickets[building]!]: { status: "building", attempts: 1 } } }));

    const step = await next(tracker, dir);

    expect(step.action).toMatch(/Nothing to do while the Ticket loop runs/);
    expect(step).toMatchObject({ issue: tickets[building] });
  });

  describe.each([
    ["the lower Ticket", 0],
    ["the higher Ticket", 1],
  ])("with %s building beside a Ticket that stopped, in one Spec", (_, building) => {
    function site(status: "parked" | "not-passed") {
      const tracker = new FakeTracker();
      const spec = inStage(tracker, "build");
      const tickets = [tracker.addTicket(spec, "Home page"), tracker.addTicket(spec, "About page")];
      const [runs, stopped] = [tickets[building]!, tickets[1 - building]!];
      const dir = kickedOffSite();
      writeFile(dir, `.factory/spec-${spec}.json`, JSON.stringify({ tickets: { [runs]: { status: "building", attempts: 1 }, [stopped]: { status, attempts: 1, reason: "A reason." } } }));
      return { tracker, dir, runs, stopped };
    }

    it("asks for the answer on a parked Ticket, says the loop has to finish first, and names no loop to start", async () => {
      const { tracker, dir, stopped } = site("parked");
      await tracker.comment(stopped, PARK_COMMENT);

      const step = await next(tracker, dir);

      expect(step).toMatchObject({ issue: stopped });
      expect(step.action).toContain(`Ticket #${stopped}`);
      expect(step.action).toMatch(/running Ticket loop has to finish first/);
      expect(step.action).not.toContain("factory loop");
    });

    it("waits for the running loop once a parked Ticket is answered", async () => {
      const { tracker, dir, runs, stopped } = site("parked");
      await tracker.comment(stopped, PARK_COMMENT);
      await tracker.comment(stopped, "Blue.");

      const step = await next(tracker, dir);

      expect(step).toMatchObject({ issue: runs });
      expect(step.action).toMatch(/Nothing to do while the Ticket loop runs/);
    });

    it("waits for the running loop beside a Ticket that did not pass", async () => {
      const { tracker, dir, runs } = site("not-passed");

      const step = await next(tracker, dir);

      expect(step).toMatchObject({ issue: runs });
      expect(step.action).toMatch(/Nothing to do while the Ticket loop runs/);
    });
  });

  it("still starts the loop of another Spec while one Spec's loop runs", async () => {
    const tracker = new FakeTracker();
    const running = inStage(tracker, "build", "Running");
    const ticket = tracker.addTicket(running, "Home page");
    tracker.addTicket(running, "About page");
    const other = tracker.addTicket(inStage(tracker, "build", "Other"), "Contact page");
    const dir = kickedOffSite();
    writeFile(dir, `.factory/spec-${running}.json`, JSON.stringify({ tickets: { [ticket]: { status: "building", attempts: 1 } } }));

    expect(await next(tracker, dir)).toMatchObject({ issue: other });
  });

  it("prints the action and the skill in plain words, and only --json as an option", async () => {
    const tracker = new FakeTracker();
    inStage(tracker, "approve");
    const dir = kickedOffSite();

    const run = await runFactory(["next"], { cwd: dir, tracker });

    expect(run.stdout).toMatch(/approve skill/);
    expect(run.stdout).toMatch(/Skill to use: approve\n$/);
    expect((await runFactory(["next", "--now"], { cwd: dir, tracker })).exitCode).toBe(2);

    tracker.closeByHand(1);
    tracker.addTicket(inStage(tracker, "build"), "Home page");
    expect((await runFactory(["next"], { cwd: dir, tracker })).stdout).toMatch(/No skill needed/);
  });
});

describe("a Spec reaching Approve", () => {
  it("moves to the Approve Stage when the Ticket loop opens its pull request, and the board and next send the Builder there", async () => {
    const { site, tracker, spec } = await specInApprove();
    writeFile(site, "AGENTS.md", KICKED_OFF);

    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
    expect(await next(tracker, site)).toMatchObject({ skill: "approve", issue: spec });
  });

  it("says in plain words that the push failed when the remote cannot be reached", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const tracker = new FakeTracker();
    const spec = inStage(tracker, "build");
    tracker.addTicket(spec, "Home page");
    git(site, "remote", "set-url", "origin", join(site, "no-such-remote"));

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker, host: new FakeHost() });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`pushing spec/${spec} to origin failed`);
  });

  it("stays in Build while a Ticket is open, and a Spec's card leaves the action to its Tickets", async () => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, "build");
    tracker.addTicket(spec, "Home page");

    const run = await runFactory(["board", "--json"], { cwd: kickedOffSite(), tracker });

    const build = (JSON.parse(run.stdout) as { columns: { stage: string; cards: { number: number; nextAction: string }[] }[] }).columns.find((column) => column.stage === "build")!;
    expect(build.cards.find((card) => card.number === spec)?.nextAction).toMatch(/its Tickets show where it stands/);
  });
});

describe("factory approve", () => {
  it("shows the Preview and the pull request while it is not merged, and changes nothing", async () => {
    const { site, tracker, host, spec, pullRequest } = await specInApprove();

    const run = await runFactory(["approve", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain(host.previews[0]!.url);
    expect(run.stdout).toContain(pullRequest.url);
    expect(run.stdout).toMatch(/not merged yet/);
    expect(pullRequest.state).toBe("open");
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
  });

  it("ends with the merged pull request and the Spec in the Publish Stage, and running again changes nothing", async () => {
    const { site, tracker, spec, pullRequest } = await specInApprove();
    tracker.mergeByHand(pullRequest.number);

    const run = await runFactory(["approve", String(spec)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracker.issue(spec).labels).toEqual(["stage:publish"]);
    expect(run.stdout).toMatch(/Publish Stage/);

    const again = await runFactory(["approve", String(spec)], { cwd: site, tracker });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/already approved/);
  });

  it("sends a Spec whose pull request was closed unmerged back to the Ticket loop, which opens a new one", async () => {
    const { site, tracker, spec, pullRequest } = await specInApprove();
    tracker.closePullRequestByHand(pullRequest.number);

    const run = await runFactory(["approve", String(spec)], { cwd: site, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`factory loop ${spec}`);
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
  });

  it("refuses what does not wait in Approve", async () => {
    const tracker = new FakeTracker();
    const spec = inStage(tracker, "design");

    const run = await runFactory(["approve", String(spec)], { cwd: kickedOffSite(), tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/not a Spec waiting in the Approve Stage/);
    expect(tracker.issue(spec).labels).toEqual(["stage:design"]);
  });

  it("needs a Spec's number", async () => {
    const tracker = new FakeTracker();
    expect((await runFactory(["approve"], { cwd: kickedOffSite(), tracker })).exitCode).toBe(2);
    expect((await runFactory(["approve", "change", "1"], { cwd: kickedOffSite(), tracker })).exitCode).toBe(2);
  });
});

describe("factory approve change", () => {
  it("files a new Ticket in the Build Stage, and the Ticket loop brings the Spec back with a new Preview on the same pull request", async () => {
    const { site, tracker, host, spec, pullRequest } = await specInApprove();

    const run = await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracker.issue(spec).labels).toEqual(["stage:build"]);
    const [ticket] = (await tracker.ticketsOf(spec)).filter((candidate) => candidate.state === "open");
    expect(ticket).toMatchObject({ title: "Bigger headline", labels: ["stage:build"] });
    expect(ticket?.body).toContain("A headline guests read from afar");
    expect(ticket?.body).toContain("The headline fills the phone's width");
    expect(run.stdout).toContain(`factory loop ${spec}`);
    expect(pullRequest.state).toBe("open");

    host.previews.length = 0;
    const rebuilt = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker, host });

    expect(rebuilt.exitCode, rebuilt.stderr).toBe(0);
    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
    expect(host.previews).toHaveLength(1);
    expect(pullRequest.body).toContain(`#${ticket?.number} Bigger headline`);
    expect(originBranch(site, `spec/${spec}`)).toBe(git(site, "rev-parse", `spec/${spec}`));
  });

  it("makes no new Preview for a rerun that pushes nothing new", async () => {
    const { site, tracker, host, spec } = await specInApprove();

    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker, host });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(host.previews).toHaveLength(1);
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
  });

  it("makes the new Preview on a rerun when the deploy failed after the change was pushed", async () => {
    const { site, tracker, host, spec, pullRequest } = await specInApprove();
    await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });
    const deploy = host.deployPreview.bind(host);
    host.deployPreview = async () => {
      throw new HostError("Firebase refused the deploy.");
    };

    const failed = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage), tracker, host });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toMatch(/Firebase refused the deploy/);

    host.deployPreview = deploy;
    host.previews.length = 0;
    const rerun = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(), tracker, host });

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect(host.previews).toHaveLength(1);
    expect(pullRequest.body).toContain("Bigger headline");
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
  });

  it("files no second Ticket when a stopped run is repeated", async () => {
    const { site, tracker, spec } = await specInApprove();
    await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });
    await tracker.moveToStage(spec, "approve");

    const again = await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });

    expect(again.exitCode, again.stderr).toBe(0);
    expect((await tracker.ticketsOf(spec)).filter((ticket) => ticket.state === "open")).toHaveLength(1);
    expect(tracker.issue(spec).labels).toEqual(["stage:build"]);
  });

  it("files each of several changes as its own Ticket, and all of them reach the same pull request", async () => {
    const { site, tracker, host, spec, pullRequest } = await specInApprove();
    await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });

    const second = await runFactory(["approve", "change", String(spec), change(site, { title: "Softer colors" })], { cwd: site, tracker });

    expect(second.exitCode, second.stderr).toBe(0);
    const open = (await tracker.ticketsOf(spec)).filter((ticket) => ticket.state === "open");
    expect(open.map((ticket) => ticket.title)).toEqual(["Bigger headline", "Softer colors"]);
    expect(tracker.issue(spec).labels).toEqual(["stage:build"]);

    const rebuilt = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildsPage, buildsPage), tracker, host });

    expect(rebuilt.exitCode, rebuilt.stderr).toBe(0);
    expect(tracker.pullRequests).toHaveLength(1);
    expect(pullRequest.body).toContain("Softer colors");
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
  });

  it("files no second Ticket when a finished run is repeated", async () => {
    const { site, tracker, spec } = await specInApprove();
    await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });

    const again = await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });

    expect(again.exitCode, again.stderr).toBe(0);
    expect((await tracker.ticketsOf(spec)).filter((ticket) => ticket.state === "open")).toHaveLength(1);
  });

  it("refuses a change to a Spec in Build that has no pull request", async () => {
    const tracker = new FakeTracker();
    const dir = createSiteRepo({ testCommand: "true" });
    const spec = inStage(tracker, "build");

    const run = await runFactory(["approve", "change", String(spec), change(dir)], { cwd: dir, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/not a Spec waiting in the Approve Stage/);
    expect(await tracker.ticketsOf(spec)).toHaveLength(0);
  });

  it("refuses a change with nothing to check, or to a merged pull request, and files nothing", async () => {
    const { site, tracker, spec, pullRequest } = await specInApprove();
    const ticketCount = async () => (await tracker.ticketsOf(spec)).length;
    const before = await ticketCount();

    const empty = await runFactory(["approve", "change", String(spec), change(site, { acceptance: [] })], { cwd: site, tracker });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toMatch(/no acceptance/);

    tracker.mergeByHand(pullRequest.number);
    const late = await runFactory(["approve", "change", String(spec), change(site)], { cwd: site, tracker });
    expect(late.exitCode).toBe(1);
    expect(late.stderr).toMatch(/new Request/);

    expect(await ticketCount()).toBe(before);
    expect(tracker.issue(spec).labels).toEqual(["stage:approve"]);
  });
});

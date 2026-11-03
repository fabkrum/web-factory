import { describe, expect, it } from "vitest";
import type { FeedbackChannel } from "../src/factory-feedback.ts";
import type { ReviewSite } from "../src/ticket-loop.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, writeFile } from "./harness/site-repo.ts";

let builds = 0;
const buildSomething = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", `<h1>build ${++builds}</h1>\n`);

/** The canonical check fails, with a reason quoting the Site's own markup, as a real reason can. */
const canonicalFails: ReviewSite = async (url) => ({
  url: url.href,
  routes: ["/"],
  passed: false,
  areas: [
    {
      area: "Visibility",
      checks: [
        {
          id: "visibility/canonical",
          name: "Canonical URL on every route",
          passed: false,
          failures: [{ reason: 'This page names no canonical address: <link rel="alternate" href="/secret-menu">', location: "/secret-menu.html" }],
        },
      ],
    },
  ],
});

/** A Spec whose Tickets are named after the Site's content, which Factory feedback must never carry. */
function specWithTickets(tracker: FakeTracker, count: number): { spec: number; tickets: number[] } {
  const spec = tracker.addSpec("Grandma's secret recipes");
  const tickets = Array.from({ length: count }, (_, index) => tracker.addTicket(spec, `Secret recipe page ${index + 1}`, "Show the recipe."));
  return { spec, tickets };
}

const site = () => createSiteRepo({ testCommand: "true", maxAttempts: 1 });

async function issues(tracker: FakeTracker) {
  return Promise.all((await tracker.openIssues()).map(async (issue) => ({ ...issue, body: (await tracker.getIssue(issue.number)).body })));
}
const factoryRequests = async (tracker: FakeTracker) => (await issues(tracker)).filter((issue) => issue.labels.includes("about:factory"));

class FakeFactoryRepository implements FeedbackChannel {
  readonly filed: { title: string; body: string }[] = [];
  async fileIssue(issue: { title: string; body: string }): Promise<string> {
    this.filed.push(issue);
    return `https://github.example.test/web-factory/issues/${this.filed.length}`;
  }
}

describe("Measure proposes Factory Requests from the Run reports", () => {
  it("turns the same Review check failing on three Tickets into one Factory Request with the three cases", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const { spec, tickets } = specWithTickets(tracker, 3);
    const agentCli = new FakeAgentCli(buildSomething, buildSomething, buildSomething);

    const run = await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli, reviewSite: canonicalFails });

    expect(run.exitCode).toBe(1);
    const [request, ...more] = await factoryRequests(tracker);
    expect(more).toEqual([]);
    expect(request!.labels).toEqual(["stage:request", "about:factory"]);
    expect(request!.title).toContain("Canonical URL");
    for (const ticket of tickets) expect(request!.body).toContain(`Ticket #${ticket}`);
    expect(request!.body).toMatch(/AGENTS\.md/);
    expect(run.stdout).toContain(`Factory Request #${request!.number}`);
  });

  it("proposes nothing for two Tickets, and does not propose the same cases twice", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const { spec } = specWithTickets(tracker, 2);

    await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli: new FakeAgentCli(buildSomething, buildSomething), reviewSite: canonicalFails });
    expect(await factoryRequests(tracker)).toEqual([]);

    const third = tracker.addTicket(spec, "Secret recipe page 3", "Show the recipe.");
    await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli: new FakeAgentCli(buildSomething), reviewSite: canonicalFails });
    const proposed = await factoryRequests(tracker);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.body).toContain(`Ticket #${third}`);

    const measured = await runFactory(["measure"], { cwd: dir, tracker });
    expect(measured.stdout).not.toContain("Factory Request");
    expect(await factoryRequests(tracker)).toHaveLength(1);
  });

  it("proposes a Factory Request when three Tickets park for the same reason", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const { spec } = specWithTickets(tracker, 3);
    const asks = () => ({ kind: "decision" as const, question: "Should the recipes show the secret ingredient?" });

    await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli: new FakeAgentCli(asks, asks, asks) });

    const [request, ...more] = await factoryRequests(tracker);
    expect(more).toEqual([]);
    expect(request!.title).toMatch(/decision/);
  });
});

describe("Every Request says whether it is about the Site or the Factory", () => {
  it("labels a Builder's Request as about the Site unless the request skill says it is about the Factory, and the board shows which", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    writeFile(dir, ".git/site.json", JSON.stringify({ title: "A menu page", body: "I want a menu." }));
    writeFile(dir, ".git/factory.json", JSON.stringify({ title: "Cut smaller Tickets", body: "My Tickets are too big.", about: "factory" }));
    writeFile(dir, ".git/wrong.json", JSON.stringify({ title: "Something", body: "Words.", about: "both" }));

    expect((await runFactory(["request", ".git/site.json"], { cwd: dir, tracker })).exitCode).toBe(0);
    expect((await runFactory(["request", ".git/factory.json"], { cwd: dir, tracker })).exitCode).toBe(0);
    const wrong = await runFactory(["request", ".git/wrong.json"], { cwd: dir, tracker });

    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toMatch(/"site" or "factory"/);
    const all = await issues(tracker);
    expect(all.map((issue) => issue.labels)).toEqual([
      ["stage:request", "about:site"],
      ["stage:request", "about:factory"],
    ]);
    const board = await runFactory(["board", "--json"], { cwd: dir, tracker });
    const cards = JSON.parse(board.stdout).columns.find((column: { stage: string }) => column.stage === "request").cards;
    expect(cards.map((card: { about: string }) => card.about)).toEqual(["site", "factory"]);
  });
});

describe("A Factory Request travels the Pipeline like any other", () => {
  it("goes through Spec, the Ticket loop, Review and Approve, its Tickets about the Factory too", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    writeFile(dir, ".git/request.json", JSON.stringify({ title: "Cut smaller Tickets", body: "My Tickets run out of time.", about: "factory" }));
    const filed = await runFactory(["request", ".git/request.json"], { cwd: dir, tracker });
    const request = Number(/#(\d+)/.exec(filed.stdout)![1]);
    writeFile(
      dir,
      ".git/spec.json",
      JSON.stringify({
        request,
        title: "Guidance on Ticket size",
        shouldDo: "The spec skill cuts Tickets that fit one session.",
        howToTell: ["AGENTS.md says how big a Ticket may be"],
        architectureDecision: null,
        tickets: [{ title: "Say how big a Ticket may be", delivers: "A rule in AGENTS.md", acceptance: ["AGENTS.md has the rule"] }],
      }),
    );

    expect((await runFactory(["spec", ".git/spec.json"], { cwd: dir, tracker })).exitCode).toBe(0);
    const [ticket] = await tracker.ticketsOf(request);
    expect(ticket!.labels).toEqual(["stage:spec", "about:factory"]);
    expect((await runFactory(["spec", "confirm", String(request)], { cwd: dir, tracker })).exitCode).toBe(0);
    expect(tracker.issue(request).labels).toEqual(["about:factory", "stage:design"]);
    // What approving the Design does, without a Design handoff, which a change to the Factory's instructions has no use for.
    await tracker.moveToStage(ticket!.number, "build");
    await tracker.moveToStage(request, "build");

    let reviewed = 0;
    const reviewSite: ReviewSite = async (url) => (reviewed++, { url: url.href, routes: ["/"], passed: true, areas: [] });
    const agentCli = new FakeAgentCli(({ cwd }) => void commitFile(cwd, "AGENTS.md", "A Ticket fits one session.\n"));
    const loop = await runFactory(["loop", String(request)], { cwd: dir, tracker, agentCli, reviewSite });
    expect(loop.exitCode, loop.stderr).toBe(0);
    expect(reviewed).toBe(1);
    expect(agentCli.reviewSessions).toHaveLength(1);
    const [pullRequest] = tracker.pullRequests;
    expect(pullRequest).toBeDefined();
    expect(tracker.issue(request).labels).toContain("stage:approve");

    tracker.mergeByHand(pullRequest!.number);
    const approved = await runFactory(["approve", String(request)], { cwd: dir, tracker });
    expect(approved.exitCode, approved.stderr).toBe(0);
    expect(tracker.issue(request).labels).toEqual(["about:factory", "stage:publish"]);
  });
});

describe("Factory feedback", () => {
  async function runWithParks() {
    const dir = site();
    const tracker = new FakeTracker();
    const { spec } = specWithTickets(tracker, 2);
    const run = await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli: new FakeAgentCli(buildSomething, buildSomething), reviewSite: canonicalFails });
    return { dir, tracker, spec, run };
  }

  it("is offered after a run with several parked Tickets, and showing it sends nothing", async () => {
    const { dir, spec, run } = await runWithParks();
    const repository = new FakeFactoryRepository();

    expect(run.stdout).toContain(`factory feedback ${spec}`);
    const shown = await runFactory(["feedback", String(spec)], { cwd: dir, feedback: repository });

    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/Nothing is sent yet/);
    expect(shown.stdout).toMatch(/2 Tickets: Review checks kept failing/);
    expect(shown.stdout).toMatch(/Canonical URL on every route: on 2 Tickets/);
    expect(repository.filed).toEqual([]);
  });

  it("is not offered after a run with at most one parked Ticket", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const { spec } = specWithTickets(tracker, 1);
    const run = await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli: new FakeAgentCli(buildSomething), reviewSite: canonicalFails });
    expect(run.stdout).not.toContain("factory feedback");
  });

  it("holds no code and no Site content", async () => {
    const { dir, spec } = await runWithParks();

    const shown = await runFactory(["feedback", String(spec)], { cwd: dir });

    for (const content of ["secret", "Secret", "recipe", "<link", "/secret-menu", "Grandma"]) expect(shown.stdout).not.toContain(content);
  });

  it("sends exactly what was shown, only with its code, and only once", async () => {
    const { dir, spec } = await runWithParks();
    const repository = new FakeFactoryRepository();
    const shown = await runFactory(["feedback", String(spec)], { cwd: dir });
    const code = /send ([0-9a-f]{8})/.exec(shown.stdout)![1]!;

    const wrong = await runFactory(["feedback", String(spec), "send", "00000000"], { cwd: dir, feedback: repository });
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toMatch(/Nothing was sent/);
    expect(repository.filed).toEqual([]);

    const sent = await runFactory(["feedback", String(spec), "send", code], { cwd: dir, feedback: repository });
    expect(sent.exitCode, sent.stderr).toBe(0);
    expect(repository.filed).toHaveLength(1);
    const [issue] = repository.filed;
    expect(shown.stdout).toContain(issue!.title);
    expect(shown.stdout).toContain(issue!.body);
    expect(sent.stdout).toContain("https://github.example.test/web-factory/issues/1");

    const again = await runFactory(["feedback", String(spec), "send", code], { cwd: dir, feedback: repository });
    expect(again.stdout).toMatch(/already sent/);
    expect(repository.filed).toHaveLength(1);
  });

  it("refuses a code shown for an earlier run once a new run changed what it would send", async () => {
    const { dir, tracker, spec } = await runWithParks();
    const repository = new FakeFactoryRepository();
    const code = /send ([0-9a-f]{8})/.exec((await runFactory(["feedback", String(spec)], { cwd: dir })).stdout)![1]!;
    tracker.addTicket(spec, "Secret recipe page 3", "Show the recipe.");
    await runFactory(["loop", String(spec)], { cwd: dir, tracker, agentCli: new FakeAgentCli(buildSomething), reviewSite: canonicalFails });

    const sent = await runFactory(["feedback", String(spec), "send", code], { cwd: dir, feedback: repository });

    expect(sent.exitCode).toBe(1);
    expect(repository.filed).toEqual([]);
  });
});

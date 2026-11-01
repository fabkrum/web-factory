import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { axeCheck } from "../src/review/axe.ts";
import { runReview, type ReviewReport } from "../src/review/review.ts";
import { ReviewError } from "../src/review/check.ts";
import { CODE_REVIEW_FILE } from "../src/code-review.ts";
import type { ReviewSite } from "../src/ticket-loop.ts";
import { approves, FakeAgentCli, reports, requestsChanges } from "./harness/fake-agent-cli.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

function oneTicketSpec() {
  const tracker = new FakeTracker();
  const spec = tracker.addSpec("A page");
  const ticket = tracker.addTicket(spec, "Add the home page", "The home page exists.");
  return { tracker, spec, ticket };
}

let builds = 0;
const buildSomething = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", `<h1>build ${++builds}</h1>\n`);

const failedReport = (url: URL): ReviewReport => ({
  url: url.href,
  routes: ["/"],
  passed: false,
  areas: [
    {
      area: "Visibility",
      checks: [
        {
          id: "visibility/canonical",
          name: "Canonical URL",
          passed: false,
          failures: [{ reason: "This page names no canonical address.", location: "/about.html" }],
        },
      ],
    },
  ],
});
const alwaysFails: ReviewSite = async (url) => failedReport(url);
const failsThenPasses = (): ReviewSite => {
  let calls = 0;
  return async (url) => (++calls === 1 ? failedReport(url) : { url: url.href, routes: ["/"], passed: true, areas: [] });
};

describe("Review checks in the Ticket loop", () => {
  it("runs the Review checks on the Ticket's build, built and served with the Site's commands, in its worktree", async () => {
    const site = createSiteRepo({
      testCommand: "true",
      buildCommand: "mkdir -p dist && cp index.html dist/index.html",
      serveCommand: `node -e "require('http').createServer((q, s) => s.end(require('fs').readFileSync('dist/index.html'))).listen({port})"`,
    });
    writeFile(site, ".gitignore", "dist\n");
    git(site, "add", ".gitignore");
    git(site, "commit", "-q", "-m", "Ignore the build");
    const { tracker, spec, ticket } = oneTicketSpec();
    const seen: { page: string; repo: string; address: string }[] = [];
    const reviewSite: ReviewSite = async (url, repo) => {
      seen.push({ page: await (await fetch(url)).text(), repo, address: url.href });
      return { url: url.href, routes: ["/"], passed: true, areas: [] };
    };
    const agentCli = new FakeAgentCli(({ cwd }) => void commitFile(cwd, "index.html", "<h1>the Ticket's build</h1>\n"));

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.page).toContain("the Ticket's build");
    expect(seen[0]?.repo).toBe(agentCli.sessions[0]?.cwd);
    await expect(fetch(seen[0]!.address)).rejects.toThrow();
    expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("hands the serve command a free port in PORT too", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec } = oneTicketSpec();
    let answered = false;
    const reviewSite: ReviewSite = async (url) => {
      answered = (await fetch(url)).ok;
      return { url: url.href, routes: [], passed: true, areas: [] };
    };

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething), tracker, reviewSite });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(answered).toBe(true);
  });

  it("sends a Ticket that fails a Review check back to Build with that check's reason, then Passes it", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething, buildSomething);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite: failsThenPasses() });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(agentCli.sessions).toHaveLength(2);
    expect(agentCli.sessions[0]?.prompt).not.toContain("names no canonical address");
    expect(agentCli.sessions[1]?.prompt).toContain("Canonical URL");
    expect(agentCli.sessions[1]?.prompt).toContain("/about.html");
    expect(agentCli.sessions[1]?.prompt).toContain("This page names no canonical address.");
    expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("measures a real failing check on a real served build and sends its reason back to Build", async () => {
    const site = createSiteRepo({
      testCommand: "true",
      serveCommand: `node -e "require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(require('fs').readFileSync('index.html')) }).listen(process.env.PORT)"`,
    });
    const { tracker, spec, ticket } = oneTicketSpec();
    const page = (image: string) => `<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1>${image}</main></body></html>\n`;
    const agentCli = new FakeAgentCli(
      ({ cwd }) => void commitFile(cwd, "index.html", page(`<img src="data:,">`)),
      ({ cwd }) => void commitFile(cwd, "index.html", page("")),
    );

    const run = await runFactory(["loop", String(spec)], {
      cwd: site,
      agentCli,
      tracker,
      reviewSite: (url, repo) => runReview(url, [axeCheck], repo),
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(agentCli.sessions).toHaveLength(2);
    expect(agentCli.sessions[1]?.prompt).toContain(axeCheck.name);
    expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("parks a Ticket that keeps failing a Review check, with the check's reason on it", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 2 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething, buildSomething);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite: alwaysFails });

    expect(run.exitCode).not.toBe(0);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.at(-1)).toMatch(/^Parked\./);
    expect(tracker.issue(ticket).comments.at(-1)).toContain("This page names no canonical address.");
  });

  it("does not leave what the build wrote in the worktree for the next attempt's gate to trip on", async () => {
    const site = createSiteRepo({ testCommand: "true", buildCommand: "mkdir -p dist && touch dist/page.html" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething, buildSomething);

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite: failsThenPasses() });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("sends a build command that fails back to Build with its reason", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1, buildCommand: "echo out of cheese; exit 3" });
    const { tracker, spec, ticket } = oneTicketSpec();

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething), tracker });

    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.at(-1)).toContain("out of cheese");
    expect(tracker.issue(ticket).comments.at(-1)).toContain("exit code 3");
  });

  it("sends a serve command that stops at once back to Build with its reason", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1, serveCommand: "echo no such folder; exit 4" });
    const { tracker, spec, ticket } = oneTicketSpec();

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething), tracker });

    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.at(-1)).toContain("no such folder");
  });

  it("stops waiting for a serve command that never answers", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1, serveCommand: "sleep 60", serveTimeoutMs: 300 });
    const { tracker, spec, ticket } = oneTicketSpec();

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething), tracker });

    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.at(-1)).toMatch(/did not answer/);
  });

  it("does not Pass a Ticket when the review cannot run", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const reviewSite: ReviewSite = async () => {
      throw new ReviewError("The Site could not be opened.");
    };

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething), tracker, reviewSite });

    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.at(-1)).toContain("The Site could not be opened.");
  });

  it("refuses to start on a Site with no serve command, so no Ticket can Pass unreviewed", async () => {
    const site = createSiteRepo({ testCommand: "true", serveCommand: null });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli();

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/serveCommand/);
    expect(agentCli.sessions).toHaveLength(0);
    expect(tracker.issue(ticket).state).toBe("open");
  });
});

describe("the code review in the Ticket loop", () => {
  it("stores its numbered points on the Ticket", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething).reviewing(approves([{ text: "The heading could be shorter." }, { text: "The page has no footer yet." }]));

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(tracker.issue(ticket).state).toBe("closed");
    const [review, pass] = tracker.issue(ticket).comments;
    expect(review).toContain("1. The heading could be shorter.");
    expect(review).toContain("2. The page has no footer yet.");
    expect(pass).toMatch(/^Pass/);
  });

  it("sends the Ticket back to Build with its points when it asks for changes", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething, buildSomething).reviewing(requestsChanges([{ text: "The form has no label." }]));

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(agentCli.sessions).toHaveLength(2);
    expect(agentCli.reviewSessions).toHaveLength(2);
    expect(agentCli.sessions[1]?.prompt).toContain("1. The form has no label.");
    expect(tracker.issue(ticket).comments[0]).toContain("1. The form has no label.");
    expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("cannot Pass a Ticket whose Review checks fail, however much it would approve", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 2 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething, buildSomething).reviewing(approves(), approves());

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, reviewSite: alwaysFails });

    expect(run.exitCode).not.toBe(0);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.every((comment) => !comment.startsWith("Pass"))).toBe(true);
    expect(git(site, "rev-parse", "spec/" + spec)).toBe(git(site, "rev-parse", "main"));
  });

  it("names the Modern Web Guidance a point goes against, on the Ticket and in the fix round", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const guidance = "Prefer native lazy loading";
    const agentCli = new FakeAgentCli(buildSomething, buildSomething).reviewing(
      requestsChanges([{ text: "The images load through a scroll listener.", guidance }]),
    );

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(agentCli.reviewSessions[0]?.prompt).toContain("Modern Web Guidance");
    expect(tracker.issue(ticket).comments[0]).toContain(`1. The images load through a scroll listener. (Modern Web Guidance: ${guidance})`);
    expect(agentCli.sessions[1]?.prompt).toContain(`Modern Web Guidance: ${guidance}`);
  });

  it("does not take a session that left no report, or an unreadable one, for an approval", async () => {
    for (const review of [() => {}, reports("looks good"), reports({ verdict: "approve", points: [{}] }), reports({ verdict: "changes", points: [] })]) {
      const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
      const { tracker, spec, ticket } = oneTicketSpec();
      const agentCli = new FakeAgentCli(buildSomething).reviewing(review);

      await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

      expect(tracker.issue(ticket).state).toBe("open");
      expect(tracker.issue(ticket).comments.at(-1)).toMatch(/no report|readable/);
    }
  });

  it("does not take a report the Build session committed for the code review's", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(
      ({ cwd }) => void commitFile(cwd, CODE_REVIEW_FILE, JSON.stringify({ verdict: "approve", points: [] })),
    ).reviewing(() => {});

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(tracker.issue(ticket).state).toBe("open");
  });

  it("merges the commit the Review checks measured, whatever the code review session did to the worktree", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    let built = "";
    const agentCli = new FakeAgentCli(({ cwd }) => void (built = commitFile(cwd, "index.html", "<h1>built</h1>\n"))).reviewing(async (session) => {
      commitFile(session.cwd, "index.html", "<h1>changed in review</h1>\n");
      writeFile(session.cwd, "stray.txt", "left behind\n");
      return approves()(session);
    });

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(git(site, "rev-parse", `spec/${spec}`)).toBe(built);
    expect(git(site, "rev-parse", `ticket/${ticket}`)).toBe(built);
  });

  it("parks when the code review session asks for a decision", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething).reviewing(() => ({ kind: "decision", question: "Is this page public?" }));

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(agentCli.sessions).toHaveLength(1);
    expect(tracker.issue(ticket).comments.at(-1)).toMatch(/^Parked\./);
    expect(tracker.issue(ticket).comments.at(-1)).toContain("Is this page public?");
  });

  it("waits out a rate limit and repeats the code review, without another Build session", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    const clock = new FakeClock();
    const agentCli = new FakeAgentCli(buildSomething).reviewing(() => ({ kind: "rate-limited", until: new Date(clock.now().getTime() + 60_000) }), approves());

    const run = await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker, clock });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(agentCli.sessions).toHaveLength(1);
    expect(agentCli.reviewSessions).toHaveLength(2);
    expect(tracker.issue(ticket).state).toBe("closed");
  });

  it("sends a code review session that failed back to Build with why", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
    const { tracker, spec, ticket } = oneTicketSpec();
    const agentCli = new FakeAgentCli(buildSomething).reviewing(() => ({ kind: "failed", reason: "The session crashed." }));

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.at(-1)).toContain("The session crashed.");
  });

  it("does not hand its own comments to a later session as the Builder's answer", async () => {
    const site = createSiteRepo({ testCommand: "true", maxAttempts: 2 });
    const { tracker, spec, ticket } = oneTicketSpec();
    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething, () => ({ kind: "decision", question: "Which one?" })), tracker, reviewSite: alwaysFails });
    await tracker.comment(ticket, "Keep the page short.");
    // The run dies in its fix round, after the code review's comment.
    const dies = new FakeAgentCli(buildSomething).reviewing(requestsChanges([{ text: "A point of the code review." }]));
    await expect(runFactory(["loop", String(spec)], { cwd: site, agentCli: dies, tracker })).rejects.toThrow();
    const answered = new FakeAgentCli(buildSomething);

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: answered, tracker });

    const answer = answered.sessions[0]?.prompt.split("Build exactly what the answer says")[1];
    expect(answer).toContain("Keep the page short.");
    expect(answer?.split("You are building")[0]).not.toContain("A point of the code review.");
  });

  it("removes its report from the worktree of a Ticket that went back to Build", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec } = oneTicketSpec();
    let leftover = true;
    const agentCli = new FakeAgentCli(buildSomething, ({ cwd }) => {
      leftover = existsSync(join(cwd, CODE_REVIEW_FILE));
      buildSomething({ cwd });
    }).reviewing(requestsChanges([{ text: "One point." }]));

    await runFactory(["loop", String(spec)], { cwd: site, agentCli, tracker });

    expect(leftover).toBe(false);
  });
});

describe("the board during Review", () => {
  it("records the Ticket as reviewing while the checks run", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const { tracker, spec, ticket } = oneTicketSpec();
    let status = "";
    const reviewSite: ReviewSite = async (url) => {
      status = JSON.parse(readFileSync(join(site, ".factory", `spec-${spec}.json`), "utf8")).tickets[String(ticket)].status;
      return { url: url.href, routes: [], passed: true, areas: [] };
    };

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(buildSomething), tracker, reviewSite });

    expect(status).toBe("reviewing");
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubTracker } from "../src/github-tracker.ts";
import type { Tracker } from "../src/tracker.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeGitHub } from "./harness/fake-github.ts";
import { delegateTo, FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

const TEMPLATE_AGENTS = readFileSync(resolve(import.meta.dirname, "..", "packages/create-web-factory/template/AGENTS.md"), "utf8");

function site(): string {
  return createSiteRepo({ testCommand: "true" });
}

/** The file a skill writes, kept out of the repository as in a real Site, then the command it runs. */
function run(dir: string, tracker: Tracker, command: string, content: unknown) {
  writeFile(dir, `.git/${command}.json`, JSON.stringify(content));
  return runFactory([command, `.git/${command}.json`], { cwd: dir, tracker });
}

const confirm = (dir: string, tracker: Tracker, spec: number) => runFactory(["spec", "confirm", String(spec)], { cwd: dir, tracker });

async function filedRequest(dir: string, tracker: FakeTracker): Promise<number> {
  const filed = await run(dir, tracker, "request", { title: "A menu page", body: "I want my guests to see the menu." });
  expect(filed.exitCode, filed.stderr).toBe(0);
  return Number(/#(\d+)/.exec(filed.stdout)![1]);
}

function specFile(request: number, overrides: Record<string, unknown> = {}) {
  return {
    request,
    title: "The menu page",
    shouldDo: "Guests read the current menu on a phone.",
    howToTell: ["The page /menu lists every dish with its price", "The menu is reachable from the home page"],
    architectureDecision: null,
    tickets: [
      { title: "Menu page with dishes", delivers: "A /menu page guests can read", acceptance: ["/menu lists the dishes"] },
      { title: "Link from home", delivers: "Guests reach the menu from the home page", acceptance: ["The home page links to /menu"], blockedBy: [1] },
    ],
    ...overrides,
  };
}

const cmsDecision = {
  title: "Use a headless CMS for the menu",
  chosen: "Decap CMS",
  recommended: "Decap CMS",
  reason: "The owner edits the menu without touching code.",
  options: [
    { name: "Decap CMS", for: "Editing in the browser", against: "One more tool" },
    { name: "Markdown files", for: "Nothing new", against: "Editing needs git" },
  ],
};

describe("factory request", () => {
  it("files the Builder's words as an issue in the Request Stage, with every Stage label in place", async () => {
    const dir = site();
    const tracker = new FakeTracker();

    const number = await filedRequest(dir, tracker);

    expect(tracker.issue(number)).toMatchObject({ title: "A menu page", body: "I want my guests to see the menu.", labels: ["stage:request", "about:site"], state: "open" });
    expect(await tracker.labels()).toHaveLength(9);
  });

  it("refuses a Request with no words and files nothing", async () => {
    const tracker = new FakeTracker();

    const filed = await run(site(), tracker, "request", { title: "A menu page", body: " " });

    expect(filed.exitCode).toBe(1);
    expect(filed.stderr).toMatch(/no body/);
    expect(await tracker.labels()).toEqual([]);
  });

  it("before any GitHub login, asks for it in plain words and files the Request once logged in", async () => {
    const dir = site();
    const github = new FakeGitHub();
    const tracker = new GitHubTracker({ cwd: dir, repo: github.repo, gh: github.gh });
    const request = { title: "A menu page", body: "I want my guests to see the menu." };
    github.loggedOut = true;

    const refused = await run(dir, tracker, "request", request);

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("gh auth login");
    expect(refused.stderr).toMatch(/your Requests, Specs and Tickets live as issues/);
    expect(refused.stderr).not.toMatch(/GH_TOKEN/);

    github.loggedOut = false;
    const filed = await run(dir, tracker, "request", request);

    expect(filed.exitCode, filed.stderr).toBe(0);
    expect(await tracker.getIssue(1)).toMatchObject({ title: "A menu page", labels: ["stage:request", "about:site"] });
  });
});

describe("factory spec", () => {
  it("turns the Request's issue into the Spec, stating how to tell, and keeps the Builder's words", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);

    const written = await run(dir, tracker, "spec", specFile(request));

    expect(written.exitCode, written.stderr).toBe(0);
    const spec = tracker.issue(request);
    expect(spec.title).toBe("The menu page");
    expect(spec.labels).toEqual(["about:site", "stage:spec"]);
    expect(spec.body).toContain("The page /menu lists every dish with its price");
    expect(spec.body).toContain("I want my guests to see the menu.");
  });

  it("files the Tickets as sub-issues in the Spec Stage with native blockers, and shows the cut in plain words", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);

    const written = await run(dir, tracker, "spec", specFile(request));

    const tickets = await tracker.ticketsOf(request);
    expect(tickets.map((ticket) => ticket.title)).toEqual(["Menu page with dishes", "Link from home"]);
    expect(tickets.map((ticket) => ticket.labels)).toEqual([["stage:spec", "about:site"], ["stage:spec", "about:site"]]);
    expect(tickets[0]?.blockedBy).toEqual([]);
    expect(tickets[1]?.blockedBy).toEqual([tickets[0]?.number]);
    expect(tickets[1]?.body).toContain("The home page links to /menu");
    expect(written.stdout).toContain("Guests reach the menu from the home page");
    expect(written.stdout).toMatch(new RegExp(`Blocked by: #${tickets[0]?.number} Menu page with dishes`));
    expect(written.stdout).toContain(`factory spec confirm ${request}`);
  });

  it("keeps the Ticket loop away until the cut is confirmed, and after it until the Design is approved", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    await run(dir, tracker, "spec", specFile(request));
    const agentCli = new FakeAgentCli();

    const before = await runFactory(["loop", String(request)], { cwd: dir, agentCli, tracker });

    expect(before.stdout).toMatch(/nothing to build/);
    expect((await tracker.ticketsOf(request)).every((ticket) => ticket.state === "open")).toBe(true);

    const confirmed = await confirm(dir, tracker, request);

    expect(confirmed.exitCode, confirmed.stderr).toBe(0);
    expect(tracker.issue(request).labels).toEqual(["about:site", "stage:design"]);
    expect((await tracker.ticketsOf(request)).map((ticket) => ticket.labels)).toEqual([["stage:spec", "about:site"], ["stage:spec", "about:site"]]);

    const after = await runFactory(["loop", String(request)], { cwd: dir, agentCli, tracker });

    expect(after.stdout).toMatch(/nothing to build/);
    expect(git(dir, "branch", "--list", "ticket/*")).toBe("");
  });

  it("replaces the cut when the Builder changes it, with no trace of the old one on the Spec", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    await run(dir, tracker, "spec", specFile(request));
    const old = await tracker.ticketsOf(request);

    const changed = await run(dir, tracker, "spec", specFile(request, { tickets: [{ title: "Everything", delivers: "The menu, linked from home", acceptance: ["It works"] }] }));

    expect(changed.exitCode, changed.stderr).toBe(0);
    expect((await tracker.ticketsOf(request)).map((ticket) => ticket.title)).toEqual(["Everything"]);
    for (const ticket of old) expect(tracker.issue(ticket.number).state).toBe("closed");
    expect(tracker.issue(request).labels).toEqual(["about:site", "stage:spec"]);
    expect(tracker.issue(request).body.match(/I want my guests to see the menu\./g)).toHaveLength(1);
  });

  it("finishes a run GitHub cut short, and a half-filed cut cannot be confirmed", async () => {
    const dir = site();
    const fake = new FakeTracker();
    const request = await filedRequest(dir, fake);
    let calls = 0;
    const flaky: Tracker = {
      ...delegateTo(fake),
      createIssue: (issue) => (++calls === 2 ? Promise.reject(new Error("gh: Server Error (HTTP 502)")) : fake.createIssue(issue)),
    };

    const stopped = await run(dir, flaky, "spec", specFile(request));

    expect(stopped.exitCode).toBe(1);
    expect(stopped.stderr).toMatch(/run this same command again/);
    expect((await confirm(dir, fake, request)).exitCode).toBe(1);
    expect(fake.issue(request).labels).toEqual(["about:site", "stage:request"]);

    const rerun = await run(dir, fake, "spec", specFile(request));

    expect(rerun.exitCode, rerun.stderr).toBe(0);
    expect((await fake.ticketsOf(request)).map((ticket) => ticket.title)).toEqual(["Menu page with dishes", "Link from home"]);
  });

  it("refuses to change a cut the Builder confirmed", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    await run(dir, tracker, "spec", specFile(request));
    await confirm(dir, tracker, request);
    const tickets = await tracker.ticketsOf(request);

    const refused = await run(dir, tracker, "spec", specFile(request));

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/past the Spec Stage/);
    expect(await tracker.ticketsOf(request)).toEqual(tickets);
  });

  it("confirming twice changes nothing and says so", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    await run(dir, tracker, "spec", specFile(request));
    await confirm(dir, tracker, request);

    const again = await confirm(dir, tracker, request);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/already confirmed/);
    expect(tracker.issue(request).labels).toEqual(["about:site", "stage:design"]);
  });

  it.each([
    ["no way to tell", { howToTell: [] }, /no howToTell/],
    ["no word on architecture", { architectureDecision: undefined }, /touches the Site's architecture/],
    ["no Tickets", { tickets: [] }, /no Tickets/],
    ["a blocker outside the cut", { tickets: [{ title: "A", delivers: "A", acceptance: ["A"], blockedBy: [2] }] }, /not another Ticket/],
    ["a Ticket blocking itself", { tickets: [{ title: "A", delivers: "A", acceptance: ["A"], blockedBy: [1] }] }, /not another Ticket/],
    [
      "Tickets blocking each other",
      { tickets: [{ title: "A", delivers: "A", acceptance: ["A"], blockedBy: [2] }, { title: "B", delivers: "B", acceptance: ["B"], blockedBy: [1] }] },
      /circle/,
    ],
    ["a Ticket with no acceptance criteria", { tickets: [{ title: "A", delivers: "A", acceptance: [] }] }, /acceptance/],
  ])("refuses a Spec with %s and changes nothing", async (_, overrides, reason) => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);

    const refused = await run(dir, tracker, "spec", specFile(request, overrides));

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(reason);
    expect(tracker.issue(request).labels).toEqual(["stage:request", "about:site"]);
    expect(await tracker.ticketsOf(request)).toEqual([]);
  });

  it("refuses a closed issue", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    tracker.closeByHand(request);

    expect((await run(dir, tracker, "spec", specFile(request))).stderr).toMatch(/is closed/);
  });

  it("asks for the login when GitHub needs one", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    tracker.loggedOut = true;

    expect((await run(dir, tracker, "spec", specFile(request))).stderr).toContain("gh auth login");
    expect((await confirm(dir, tracker, request)).stderr).toContain("gh auth login");
  });

  describe("a Request that touches architecture", () => {
    function kickedOffSite(): string {
      const dir = site();
      const stack = TEMPLATE_AGENTS.replace(/## Stack[\s\S]*$/, "## Stack\n\nDecided at Kickoff.\n\n- Stack: Astro\n");
      commitFile(dir, "AGENTS.md", stack);
      commitFile(dir, "docs/adr/0001-stack.md", "# Build the Site with Astro\n");
      commitFile(dir, "docs/adr/0002-host.md", "# Host the Site on Firebase\n");
      return dir;
    }

    it("raises a new Architecture decision: a numbered ADR with every option, named in the Stack section and the Spec, and committed", async () => {
      const dir = kickedOffSite();
      const tracker = new FakeTracker();
      const request = await filedRequest(dir, tracker);

      const written = await run(dir, tracker, "spec", specFile(request, { architectureDecision: cmsDecision }));

      expect(written.exitCode, written.stderr).toBe(0);
      const path = "docs/adr/0003-use-a-headless-cms-for-the-menu.md";
      expect(readdirSync(join(dir, "docs/adr"))).toContain("0003-use-a-headless-cms-for-the-menu.md");
      const adr = readFileSync(join(dir, path), "utf8");
      for (const text of ["Decap CMS", "Markdown files", "Editing needs git", "The owner edits the menu", `Request #${request}`]) expect(adr).toContain(text);
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(path);
      expect(tracker.issue(request).body).toContain(path);
      expect(git(dir, "status", "--porcelain")).toBe("");
      expect(written.stdout).toContain("git push");
    });

    it("records it once when the same file runs again", async () => {
      const dir = kickedOffSite();
      const tracker = new FakeTracker();
      const request = await filedRequest(dir, tracker);
      const file = specFile(request, { architectureDecision: cmsDecision });

      await run(dir, tracker, "spec", file);
      const head = git(dir, "rev-parse", "HEAD");
      await run(dir, tracker, "spec", file);

      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
      expect(readdirSync(join(dir, "docs/adr"))).toHaveLength(3);
    });

    it("raises a new ADR when its title collides with a Kickoff ADR, and leaves that record alone", async () => {
      const dir = kickedOffSite();
      const tracker = new FakeTracker();
      const request = await filedRequest(dir, tracker);

      const written = await run(dir, tracker, "spec", specFile(request, { architectureDecision: { ...cmsDecision, title: "Host" } }));

      expect(written.exitCode, written.stderr).toBe(0);
      expect(readFileSync(join(dir, "docs/adr/0002-host.md"), "utf8")).toBe("# Host the Site on Firebase\n");
      expect(readFileSync(join(dir, "docs/adr/0003-host.md"), "utf8")).toContain("Decap CMS");
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("docs/adr/0003-host.md");
      expect(tracker.issue(request).body).toContain("docs/adr/0003-host.md");
      expect(git(dir, "status", "--porcelain")).toBe("");
    });

    it("raises a new ADR when its title collides with another Request's, and a rerun still finds its own", async () => {
      const dir = kickedOffSite();
      const tracker = new FakeTracker();
      const first = await filedRequest(dir, tracker);
      const second = await filedRequest(dir, tracker);
      const firstPath = "docs/adr/0003-use-a-headless-cms-for-the-menu.md";
      const secondPath = "docs/adr/0004-use-a-headless-cms-for-the-menu.md";
      const secondFile = specFile(second, { architectureDecision: { ...cmsDecision, chosen: "Markdown files", reason: "Nothing new to learn." } });

      await run(dir, tracker, "spec", specFile(first, { architectureDecision: cmsDecision }));
      const firstAdr = readFileSync(join(dir, firstPath), "utf8");
      const written = await run(dir, tracker, "spec", secondFile);

      expect(written.exitCode, written.stderr).toBe(0);
      expect(readFileSync(join(dir, firstPath), "utf8")).toBe(firstAdr);
      expect(readFileSync(join(dir, secondPath), "utf8")).toContain("Nothing new to learn.");
      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      expect(agents).toContain(firstPath);
      expect(agents).toContain(secondPath);

      const head = git(dir, "rev-parse", "HEAD");
      await run(dir, tracker, "spec", secondFile);
      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
      expect(readdirSync(join(dir, "docs/adr"))).toHaveLength(4);
    });

    it("does not take a Request whose number starts the same for this one", async () => {
      const dir = kickedOffSite();
      const tracker = new FakeTracker();
      const request = await filedRequest(dir, tracker);
      commitFile(dir, "docs/adr/0003-use-a-headless-cms-for-the-menu.md", `# Use a headless CMS for the menu\n\nRaised by Request #${request}0: other words\n`);

      await run(dir, tracker, "spec", specFile(request, { architectureDecision: cmsDecision }));

      expect(readFileSync(join(dir, "docs/adr/0003-use-a-headless-cms-for-the-menu.md"), "utf8")).toContain("other words");
      expect(readdirSync(join(dir, "docs/adr"))).toContain("0004-use-a-headless-cms-for-the-menu.md");
    });

    it("refuses before Kickoff, when there is no architecture to change", async () => {
      const dir = site();
      commitFile(dir, "AGENTS.md", TEMPLATE_AGENTS);
      const tracker = new FakeTracker();
      const request = await filedRequest(dir, tracker);

      const refused = await run(dir, tracker, "spec", specFile(request, { architectureDecision: cmsDecision }));

      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/kickoff skill/);
      expect(tracker.issue(request).labels).toEqual(["stage:request", "about:site"]);
    });
  });
});

describe("factory spec confirm", () => {
  it("refuses a Request that has no cut yet", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);

    const refused = await confirm(dir, tracker, request);

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/no cut to confirm/);
    expect(tracker.issue(request).labels).toEqual(["stage:request", "about:site"]);
  });

  it("refuses a Ticket's number, which has no cut of its own", async () => {
    const dir = site();
    const tracker = new FakeTracker();
    const request = await filedRequest(dir, tracker);
    await run(dir, tracker, "spec", specFile(request));
    const [ticket] = await tracker.ticketsOf(request);

    const refused = await confirm(dir, tracker, ticket!.number);

    expect(refused.exitCode).toBe(1);
    expect(tracker.issue(ticket!.number).labels).toEqual(["stage:spec", "about:site"]);
  });

  it("needs a Spec number", async () => {
    expect((await runFactory(["spec", "confirm", "twelve"], { cwd: site(), tracker: new FakeTracker() })).exitCode).toBe(2);
  });
});

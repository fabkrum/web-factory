import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_CHECKS } from "../src/review/review.ts";
import { DESIGN_FORMAT_VERSION } from "../src/design-handoff.ts";
import { NpmReleases } from "../src/releases.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeReleases } from "./harness/fake-releases.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { serveFakePackageRegistry } from "./harness/fake-package-registry.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, originBranch, writeFile } from "./harness/site-repo.ts";

const SKILL = ".agents/skills/spec/SKILL.md";
const BRANCH = "factory-update";

function manifest(version: string): string {
  return `${JSON.stringify({ name: "a-site", private: true, devDependencies: { "@fabkrum/web-factory": version } }, null, 2)}\n`;
}

/** A Site on Factory 1.0.0, made from that release's files and pushed to `origin`. */
function siteOn(template: Record<string, string>): string {
  const site = createSiteRepo({ testCommand: "true", maxAttempts: 1 });
  writeFile(site, "package.json", manifest("1.0.0"));
  for (const [path, content] of Object.entries(template)) writeFile(site, path === "gitignore" ? ".gitignore" : path, content);
  git(site, "add", "-A");
  git(site, "commit", "-q", "-m", "Start the Site with the Factory");
  git(site, "push", "-q", "origin", "main");
  return site;
}

/** What the update branch on `origin` says a file holds. */
function onBranch(site: string, path: string): string {
  git(site, "fetch", "-q", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
  return git(site, "show", `refs/remotes/origin/${BRANCH}:${path}`);
}

function branchHas(site: string, path: string): boolean {
  git(site, "fetch", "-q", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
  return git(site, "ls-tree", "--name-only", `refs/remotes/origin/${BRANCH}`, path) !== "";
}

describe("factory update", () => {
  let tracker: FakeTracker;

  beforeEach(() => {
    tracker = new FakeTracker();
  });

  it("opens a pull request listing what changed", async () => {
    const site = siteOn({ [SKILL]: "cut thin\n", ".agents/skills/gone/SKILL.md": "old\n" });
    const releases = new FakeReleases("1.1.0", {
      "1.0.0": { reviewChecks: ["a/one", "a/old"], modernWebGuidance: "0.0.196", designFormat: "alpha", template: { [SKILL]: "cut thin\n", ".agents/skills/gone/SKILL.md": "old\n" } },
      "1.1.0": {
        reviewChecks: ["a/one", "a/new"],
        modernWebGuidance: "0.0.200",
        designFormat: "beta",
        template: { [SKILL]: "cut thinner\n", ".agents/skills/fresh/SKILL.md": "new\n" },
      },
    });

    const result = await runFactory(["update"], { cwd: site, tracker, releases });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const [pullRequest] = tracker.pullRequests;
    expect(pullRequest).toMatchObject({ head: BRANCH, base: "main", state: "open" });
    expect(result.stdout).toContain(pullRequest!.url);
    const body = pullRequest!.body;
    expect(body).toContain("Factory: 1.0.0 → 1.1.0");
    expect(body).toContain("Modern Web Guidance: 0.0.196 → 0.0.200");
    expect(body).toContain("DESIGN.md format: alpha → beta");
    expect(body).toMatch(/New skills: fresh/);
    expect(body).toMatch(/Changed skills: spec/);
    expect(body).toMatch(/Removed skills: gone/);
    expect(body).toMatch(/New Review checks: a\/new/);
    expect(body).toMatch(/Removed Review checks: a\/old/);

    expect(JSON.parse(onBranch(site, "package.json")).devDependencies["@fabkrum/web-factory"]).toBe("1.1.0");
    expect(onBranch(site, "package-lock.json")).toContain("1.1.0");
    expect(onBranch(site, SKILL)).toBe("cut thinner");
    expect(onBranch(site, ".agents/skills/fresh/SKILL.md")).toBe("new");
    expect(branchHas(site, ".agents/skills/gone/SKILL.md")).toBe(false);
  });

  it("changes nothing in the Site without the merge", async () => {
    const site = siteOn({ [SKILL]: "cut thin\n" });
    writeFile(site, "work-in-progress.txt", "the Builder's\n");
    const head = git(site, "rev-parse", "HEAD");
    const worktrees = git(site, "worktree", "list");
    const releases = new FakeReleases("1.1.0", { "1.0.0": { template: { [SKILL]: "cut thin\n" } }, "1.1.0": { template: { [SKILL]: "cut thinner\n" } } });

    expect((await runFactory(["update"], { cwd: site, tracker, releases })).exitCode).toBe(0);

    expect(git(site, "rev-parse", "HEAD")).toBe(head);
    expect(originBranch(site, "main")).toBe(head);
    expect(git(site, "branch", "--show-current")).toBe("main");
    expect(git(site, "branch", "--list", BRANCH)).toBe("");
    expect(git(site, "status", "--porcelain")).toBe("?? work-in-progress.txt");
    expect(readFileSync(join(site, SKILL), "utf8")).toBe("cut thin\n");
    expect(JSON.parse(readFileSync(join(site, "package.json"), "utf8")).devDependencies["@fabkrum/web-factory"]).toBe("1.0.0");
    expect(git(site, "worktree", "list")).toBe(worktrees);
  });

  it("builds on what is on GitHub, not on the Builder's copy", async () => {
    const site = siteOn({ [SKILL]: "cut thin\n" });
    commitFile(site, "local.txt", "not pushed\n");
    const releases = new FakeReleases("1.1.0", { "1.0.0": {}, "1.1.0": {} });

    await runFactory(["update"], { cwd: site, tracker, releases });

    expect(branchHas(site, "local.txt")).toBe(false);
  });

  it("keeps a file the Site changed itself when the release changed it too, and says so", async () => {
    const site = siteOn({ [SKILL]: "cut thin, our way\n", "AGENTS.md": "## Stack\n\nAstro\n" });
    const releases = new FakeReleases("1.1.0", {
      "1.0.0": { template: { [SKILL]: "cut thin\n", "AGENTS.md": "## Stack\n\nNot decided\n" } },
      "1.1.0": { template: { [SKILL]: "cut thinner\n", "AGENTS.md": "## Stack\n\nNot decided yet\n" } },
    });

    await runFactory(["update"], { cwd: site, tracker, releases });

    expect(onBranch(site, SKILL)).toBe("cut thin, our way");
    expect(onBranch(site, "AGENTS.md")).toContain("Astro");
    const body = tracker.pullRequests[0]!.body;
    expect(body).toContain(SKILL);
    expect(body).toContain("AGENTS.md");
    expect(body).not.toMatch(/Changed skills/);
  });

  it("leaves alone what the release did not change, and the Builder's own skills", async () => {
    const site = siteOn({ [SKILL]: "cut thin, our way\n", ".agents/skills/mine/SKILL.md": "my own\n", gitignore: "node_modules/\ncustom/\n" });
    const releases = new FakeReleases("1.1.0", {
      "1.0.0": { template: { [SKILL]: "cut thin\n", gitignore: "node_modules/\n" } },
      "1.1.0": { template: { [SKILL]: "cut thin\n", gitignore: "node_modules/\n" } },
    });

    await runFactory(["update"], { cwd: site, tracker, releases });

    expect(onBranch(site, SKILL)).toBe("cut thin, our way");
    expect(onBranch(site, ".agents/skills/mine/SKILL.md")).toBe("my own");
    expect(onBranch(site, ".gitignore")).toContain("custom/");
    expect(tracker.pullRequests[0]!.body).not.toContain(SKILL);
  });

  it("says what a Site with a DESIGN.md must do when the format moves", async () => {
    const site = siteOn({ "design/DESIGN.md": "---\nversion: alpha\n---\n" });
    const releases = new FakeReleases("1.1.0", { "1.0.0": { designFormat: "alpha" }, "1.1.0": { designFormat: "beta" } });

    await runFactory(["update"], { cwd: site, tracker, releases });

    expect(tracker.pullRequests[0]!.body).toMatch(/design\/DESIGN\.md.*beta/);
    expect(onBranch(site, "design/DESIGN.md")).toContain("version: alpha");
  });

  it("does nothing when the Site already has the newest Factory", async () => {
    const site = siteOn({});
    const releases = new FakeReleases("1.0.0", {});

    const result = await runFactory(["update"], { cwd: site, tracker, releases });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already/i);
    expect(tracker.pullRequests).toEqual([]);
    expect(originBranch(site, BRANCH)).toBeUndefined();
  });

  it("does not go back to an older Factory", async () => {
    const site = siteOn({});
    git(site, "checkout", "-q", "main");
    commitFile(site, "package.json", manifest("1.10.0"));
    git(site, "push", "-q", "origin", "main");
    const releases = new FakeReleases("1.9.0", {});

    expect((await runFactory(["update"], { cwd: site, tracker, releases })).exitCode).toBe(0);

    expect(tracker.pullRequests).toEqual([]);
  });

  it("run again, finds its open pull request instead of opening a second one", async () => {
    const site = siteOn({});
    const releases = new FakeReleases("1.1.0", { "1.0.0": {}, "1.1.0": {} });
    await runFactory(["update"], { cwd: site, tracker, releases });
    const pushed = originBranch(site, BRANCH);

    const again = await runFactory(["update"], { cwd: site, tracker, releases });

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain(tracker.pullRequests[0]!.url);
    expect(tracker.pullRequests).toHaveLength(1);
    expect(originBranch(site, BRANCH)).toBe(pushed);
  });

  it("moves its open pull request on when a newer release came out", async () => {
    const site = siteOn({});
    const first = new FakeReleases("1.1.0", { "1.0.0": {}, "1.1.0": {} });
    await runFactory(["update"], { cwd: site, tracker, releases: first });
    const newer = new FakeReleases("1.2.0", { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} });

    await runFactory(["update"], { cwd: site, tracker, releases: newer });

    expect(tracker.pullRequests).toHaveLength(1);
    expect(tracker.pullRequests[0]!.body).toContain("Factory: 1.0.0 → 1.2.0");
    expect(JSON.parse(onBranch(site, "package.json")).devDependencies["@fabkrum/web-factory"]).toBe("1.2.0");
  });

  it("opens a new pull request for the next release after the last one was merged", async () => {
    const site = siteOn({});
    await runFactory(["update"], { cwd: site, tracker, releases: new FakeReleases("1.1.0", { "1.0.0": {}, "1.1.0": {} }) });
    tracker.mergeByHand(tracker.pullRequests[0]!.number);
    git(site, "fetch", "-q", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
    git(site, "merge", "-q", "--ff-only", `refs/remotes/origin/${BRANCH}`);
    git(site, "push", "-q", "origin", "main");

    await runFactory(["update"], { cwd: site, tracker, releases: new FakeReleases("1.2.0", { "1.1.0": {}, "1.2.0": {} }) });

    expect(tracker.pullRequests).toHaveLength(2);
    expect(tracker.pullRequests[1]!.body).toContain("Factory: 1.1.0 → 1.2.0");
  });

  it("asks for the GitHub login when nobody is logged in, and pushes nothing", async () => {
    const site = siteOn({});
    tracker.loggedOut = true;
    const releases = new FakeReleases("1.1.0", { "1.0.0": {}, "1.1.0": {} });

    const result = await runFactory(["update"], { cwd: site, tracker, releases });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gh auth login");
    expect(originBranch(site, BRANCH)).toBeUndefined();
  });

  it("refuses in plain words when the Site has no pinned Factory", async () => {
    const site = createSiteRepo({ testCommand: "true" });

    const result = await runFactory(["update"], { cwd: site, tracker, releases: new FakeReleases("1.1.0", {}) });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/does not pin/);
  });

  it("takes no arguments", async () => {
    const site = siteOn({});
    const result = await runFactory(["update", "now"], { cwd: site, tracker, releases: new FakeReleases("1.1.0", {}) });
    expect(result.exitCode).toBe(2);
  });
});

describe("pinned versions in the Ticket loop", () => {
  async function loopWhere(session: (cwd: string) => void) {
    const site = siteOn({ ".agents/skills/modern-web-guidance/SKILL.md": "guidance\n" });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A Spec");
    const ticket = tracker.addTicket(spec, "A Ticket");
    const agentCli = new FakeAgentCli(...[1, 2, 3].map(() => ({ cwd }: { cwd: string }) => session(cwd)));
    const result = await runFactory(["loop", String(spec)], { cwd: site, tracker, agentCli });
    return { result, tracker, ticket };
  }

  it("refuses a Ticket that moves the Factory's pin", async () => {
    const { result, tracker, ticket } = await loopWhere((cwd) => commitFile(cwd, "package.json", manifest("9.9.9")));
    expect(result.exitCode).toBe(1);
    expect(tracker.issue(ticket).state).toBe("open");
    expect(tracker.issue(ticket).comments.join("\n")).toContain("factory update");
  });

  it("refuses a Ticket that changes the vendored Modern Web Guidance", async () => {
    const { result, tracker, ticket } = await loopWhere((cwd) => commitFile(cwd, ".agents/skills/modern-web-guidance/SKILL.md", "other\n"));
    expect(result.exitCode).toBe(1);
    expect(tracker.issue(ticket).comments.join("\n")).toContain("factory update");
  });

  it("lets a Ticket change package.json around the pin", async () => {
    const { result, tracker, ticket } = await loopWhere((cwd) => {
      const changed = { ...JSON.parse(manifest("1.0.0")), scripts: { test: "true" } };
      commitFile(cwd, "package.json", `${JSON.stringify(changed, null, 2)}\n`);
    });
    expect(result.exitCode).toBe(0);
    expect(tracker.issue(ticket).state).toBe("closed");
  });
});

describe("the starter's release facts", () => {
  const starter = resolve(import.meta.dirname, "..", "packages", "create-web-factory");
  const facts = JSON.parse(readFileSync(join(starter, "release.json"), "utf8")) as { designFormat: string; modernWebGuidance: string; reviewChecks: string[] };

  it("say what this release really carries", () => {
    expect(facts.designFormat).toBe(DESIGN_FORMAT_VERSION);
    expect(facts.reviewChecks).toEqual(REVIEW_CHECKS.map((check) => check.id));
    expect(readFileSync(join(starter, "template/.agents/skills/modern-web-guidance/NOTICE"), "utf8")).toContain(`version ${facts.modernWebGuidance}`);
  });

  it("are published with the starter", () => {
    const { files } = JSON.parse(readFileSync(join(starter, "package.json"), "utf8")) as { files: string[] };
    expect(files).toContain("release.json");
  });
});

describe("NpmReleases, the real npm against a local registry", () => {
  it("finds the newest release, unpacks its template and moves the pin with the lockfile", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-factory-releases-"));
    const packed = (name: string, files: Record<string, string>) => {
      const dir = join(root, name.replace(/\W/g, "-"));
      mkdirSync(dir);
      for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
      execFileSync("npm", ["pack", "--pack-destination", root, "--silent"], { cwd: dir, stdio: "ignore" });
      return join(root, name === "create-web-factory" ? "create-web-factory-1.1.0.tgz" : "fabkrum-web-factory-1.1.0.tgz");
    };
    const starter = packed("create-web-factory", {
      "package.json": JSON.stringify({ name: "create-web-factory", version: "1.1.0", files: ["release.json", "template"] }),
      "release.json": JSON.stringify({ designFormat: "beta", modernWebGuidance: "0.0.200", reviewChecks: ["a/one"] }),
      "template/AGENTS.md": "instructions\n",
    });
    const factory = packed("@fabkrum/web-factory", { "package.json": JSON.stringify({ name: "@fabkrum/web-factory", version: "1.1.0" }) });
    const registry = await serveFakePackageRegistry([{ tarball: starter }, { tarball: factory }]);
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_registry: registry.url, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false" };
    try {
      const site = join(root, "site");
      mkdirSync(site);
      writeFileSync(join(site, "package.json"), `${JSON.stringify({ name: "a-site", private: true, devDependencies: {} }, null, 2)}\n`);
      const releases = new NpmReleases({ cwd: site, env });

      expect(await releases.latest()).toBe("1.1.0");

      const into = join(root, "unpacked");
      mkdirSync(into);
      const release = await releases.fetch("1.1.0", into);
      expect(release).toMatchObject({ designFormat: "beta", modernWebGuidance: "0.0.200", reviewChecks: ["a/one"] });
      expect(readFileSync(join(release.template, "AGENTS.md"), "utf8")).toBe("instructions\n");

      await releases.pin(site, "1.1.0");
      expect(JSON.parse(readFileSync(join(site, "package.json"), "utf8")).devDependencies["@fabkrum/web-factory"]).toBe("1.1.0");
      expect(existsSync(join(site, "package-lock.json"))).toBe(true);
      expect(existsSync(join(site, "node_modules"))).toBe(false);
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says plainly when npm cannot be reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-factory-releases-"));
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_registry: "http://127.0.0.1:9/", npm_config_cache: join(root, "c"), npm_config_fetch_retries: "0" };
    await expect(new NpmReleases({ cwd: root, env }).latest()).rejects.toThrow(/npm/);
    rmSync(root, { recursive: true, force: true });
  });
});

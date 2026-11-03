import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FirebaseHost } from "../src/firebase-host.ts";
import { FakeHost } from "./harness/fake-host.ts";
import { hostContract } from "./harness/host-contract.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo, git, writeFile } from "./harness/site-repo.ts";

const FAKE_FIREBASE = [process.execPath, fileURLToPath(new URL("./harness/fake-firebase.ts", import.meta.url))];

/** What `firebase init hosting` leaves in a Site. */
function commitFirebaseSetup(dir: string, project: string): void {
  commitFile(dir, "firebase.json", `${JSON.stringify({ hosting: { public: "." } })}\n`);
  commitFile(dir, ".firebaserc", `${JSON.stringify({ projects: { default: project } })}\n`);
}

function fakeFirebase(env: Record<string, string> = {}) {
  const state = mkdtempSync(join(tmpdir(), "web-factory-firebase-"));
  return {
    state,
    host: new FirebaseHost({ command: FAKE_FIREBASE, env: { ...process.env, FAKE_FIREBASE_STATE: state, ...env } }),
    read: async (url: string) => readFileSync(join(state, encodeURIComponent(url)), "utf8"),
  };
}

hostContract("the fake host", async () => {
  const host = new FakeHost();
  return { host, prepareSite: () => {}, read: (url) => host.read(url) };
});

hostContract("the Firebase adapter against a fake Firebase CLI", async () => {
  const { host, read } = fakeFirebase();
  return { host, read, prepareSite: (dir) => commitFirebaseSetup(dir, "my-site") };
});

/**
 * The real contract: the Firebase adapter against a disposable Firebase project, which it
 * publishes to. CI sets WEB_FACTORY_FIREBASE_PROJECT and GOOGLE_APPLICATION_CREDENTIALS from
 * the maintainer's variable and secret; without them, or without the CLI, it is skipped.
 */
const contractProject = process.env.WEB_FACTORY_FIREBASE_PROJECT;
const contractSkip = realContractSkipReason();
// The title alone shows in no default report, and the skip must say why.
if (contractSkip) process.stderr.write(`The real Firebase contract is skipped: ${contractSkip}\n`);
hostContract(
  "the Firebase adapter against a disposable Firebase project",
  async () => ({
    host: new FirebaseHost({ command: ["firebase"] }),
    read: async (url) => (await fetch(url)).text(),
    prepareSite: (dir) => commitFirebaseSetup(dir, contractProject!),
  }),
  { skip: contractSkip, timeout: 5 * 60_000 },
);

function realContractSkipReason(): string | undefined {
  if (!contractProject) return "WEB_FACTORY_FIREBASE_PROJECT is not set; set it to a disposable Firebase project";
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return "GOOGLE_APPLICATION_CREDENTIALS is not set; in CI it is a file written from the CONTRACT_FIREBASE_SERVICE_ACCOUNT secret";
  }
  try {
    execFileSync("firebase", ["--version"], { stdio: "ignore" });
  } catch {
    return "the Firebase CLI (firebase) is not installed";
  }
  return undefined;
}

function firebaseSite(options: { buildCommand?: string } = {}): string {
  const site = createSiteRepo({ testCommand: "true", ...options });
  commitFirebaseSetup(site, "my-site");
  commitFile(site, "index.html", "<h1>main</h1>\n");
  return site;
}

describe("the Firebase adapter", () => {
  it("names each preview channel after the branch, in the form Firebase takes", async () => {
    const { host } = fakeFirebase();
    const site = firebaseSite();
    git(site, "branch", "Spec/12_Home");

    expect(await host.deployPreview({ siteDir: site, branch: "Spec/12_Home" })).toBe("https://my-site--spec-12-home-abc123.web.app");
  });

  it("deploys what the Site's build command made from the branch, not what the Site has on its own branch", async () => {
    const { host, read } = fakeFirebase();
    const site = createSiteRepo({ testCommand: "true", buildCommand: "mkdir -p dist && cp page.txt dist/index.html" });
    commitFile(site, "firebase.json", `${JSON.stringify({ hosting: { public: "dist" } })}\n`);
    commitFile(site, ".firebaserc", `${JSON.stringify({ projects: { default: "my-site" } })}\n`);
    commitFile(site, "page.txt", "main\n");
    git(site, "checkout", "-q", "-b", "spec/1");
    commitFile(site, "page.txt", "the branch\n");
    git(site, "checkout", "-q", "main");

    const url = await host.deployPreview({ siteDir: site, branch: "spec/1" });

    expect(await read(url)).toBe("the branch\n");
  });

  it("builds a Preview with a dependency only the branch has", async () => {
    const { host, read } = fakeFirebase({ npm_config_cache: mkdtempSync(join(tmpdir(), "web-factory-npm-")) });
    const site = createSiteRepo({ testCommand: "true", buildCommand: `mkdir -p dist && node -e "require('fs').writeFileSync('dist/index.html', require('only-on-branch'))"` });
    commitFile(site, "firebase.json", `${JSON.stringify({ hosting: { public: "dist" } })}\n`);
    commitFile(site, ".firebaserc", `${JSON.stringify({ projects: { default: "my-site" } })}\n`);
    git(site, "checkout", "-q", "-b", "spec/1");
    const dependency = "vendor/only-on-branch";
    commitFile(site, `${dependency}/package.json`, `${JSON.stringify({ name: "only-on-branch", version: "1.0.0", main: "index.js" })}\n`);
    commitFile(site, `${dependency}/index.js`, `module.exports = "from the dependency";\n`);
    const root = { name: "a-site", version: "1.0.0", dependencies: { "only-on-branch": `file:${dependency}` } };
    commitFile(site, "package.json", `${JSON.stringify(root)}\n`);
    const packages = { "": root, "node_modules/only-on-branch": { resolved: dependency, link: true }, [dependency]: { version: "1.0.0" } };
    commitFile(site, "package-lock.json", `${JSON.stringify({ name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages })}\n`);
    git(site, "checkout", "-q", "main");

    const url = await host.deployPreview({ siteDir: site, branch: "spec/1" });

    expect(await read(url)).toBe("from the dependency");
  });

  it("says plainly when the Preview's dependencies cannot be installed", async () => {
    const { host } = fakeFirebase({ npm_config_cache: mkdtempSync(join(tmpdir(), "web-factory-npm-")) });
    const site = firebaseSite();
    commitFile(site, "package.json", `${JSON.stringify({ name: "a-site", version: "1.0.0" })}\n`);
    commitFile(site, "package-lock.json", "not a lockfile\n");
    git(site, "branch", "spec/1");

    await expect(host.deployPreview({ siteDir: site, branch: "spec/1" })).rejects.toThrow(/could not install the Site's dependencies with `npm ci`/);
  });

  it("installs the Preview's dependencies without the Factory's secrets", async () => {
    const { host } = fakeFirebase({ npm_config_cache: mkdtempSync(join(tmpdir(), "web-factory-npm-")), GH_TOKEN: "ghp_secret-the-install-must-not-see" });
    const site = firebaseSite();
    const root = { name: "a-site", version: "1.0.0", scripts: { postinstall: `node -e "console.error('GH_TOKEN=' + process.env.GH_TOKEN); process.exit(1)"` } };
    commitFile(site, "package.json", `${JSON.stringify(root)}\n`);
    const packages = { "": { name: root.name, version: root.version } };
    commitFile(site, "package-lock.json", `${JSON.stringify({ name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages })}\n`);
    git(site, "branch", "spec/1");

    await expect(host.deployPreview({ siteDir: site, branch: "spec/1" })).rejects.toThrow(/GH_TOKEN=undefined/);
  });

  it("runs the Firebase CLI without the Factory's secrets, even one the branch brings itself", async () => {
    // npx prefers a firebase-tools in the project's own node_modules: the Spec branch picks that code.
    const site = firebaseSite();
    git(site, "checkout", "--quiet", "-b", "spec/1");
    const leak = `console.log(JSON.stringify({ status: "success", result: { live: { url: "https://leak.example/" + process.env.GH_TOKEN + "/" + process.env.GOOGLE_APPLICATION_CREDENTIALS } } }));\n`;
    writeFile(site, "node_modules/firebase-tools/cli.js", `#!/usr/bin/env node\n${leak}`);
    writeFile(site, "node_modules/firebase-tools/package.json", `${JSON.stringify({ name: "firebase-tools", version: "99.0.0", bin: { "firebase-tools": "cli.js", firebase: "cli.js" } })}\n`);
    chmodSync(join(site, "node_modules/firebase-tools/cli.js"), 0o755);
    mkdirSync(join(site, "node_modules/.bin"), { recursive: true });
    symlinkSync("../firebase-tools/cli.js", join(site, "node_modules/.bin/firebase-tools"));
    symlinkSync("../firebase-tools/cli.js", join(site, "node_modules/.bin/firebase"));
    git(site, "add", "--force", "node_modules");
    git(site, "commit", "--quiet", "-m", "A branch that brings its own Firebase CLI");
    git(site, "checkout", "--quiet", "main");
    const host = new FirebaseHost({
      env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "web-factory-npm-")), GH_TOKEN: "ghp_secret-the-cli-must-not-see", GOOGLE_APPLICATION_CREDENTIALS: "/keys/firebase.json" },
    });

    expect(await host.deployPreview({ siteDir: site, branch: "spec/1" })).toBe("https://leak.example/undefined//keys/firebase.json");
  });

  it("publishes to the site named in firebase.json when it names one", async () => {
    const { host } = fakeFirebase();
    const site = firebaseSite();
    commitFile(site, "firebase.json", `${JSON.stringify({ hosting: { public: ".", site: "my-brand" } })}\n`);

    expect(await host.publishLive({ siteDir: site })).toBe("https://my-brand.web.app");
  });

  it("says plainly when the build fails, and leaves no worktree behind", async () => {
    const { host } = fakeFirebase();
    const site = firebaseSite({ buildCommand: "echo broken page; exit 3" });
    git(site, "branch", "spec/1");
    const worktrees = git(site, "worktree", "list");

    await expect(host.deployPreview({ siteDir: site, branch: "spec/1" })).rejects.toThrow(/build command .*broken page/s);
    expect(git(site, "worktree", "list")).toBe(worktrees);
  });

  it("tells the Builder to log in when Firebase wants a login", async () => {
    const { host } = fakeFirebase({ FAKE_FIREBASE_ERROR: "Failed to authenticate, have you run firebase login?" });
    const site = firebaseSite();

    await expect(host.publishLive({ siteDir: site })).rejects.toThrow(/firebase-tools login/);
  });

  it("says plainly when the Firebase CLI cannot start", async () => {
    const site = firebaseSite();
    const host = new FirebaseHost({ command: ["firebase-that-is-not-installed"] });

    await expect(host.publishLive({ siteDir: site })).rejects.toThrow(/could not be started/);
  });

  it("refuses to connect a Site without its Firebase setup, and names the step", async () => {
    const { host } = fakeFirebase();
    const site = createSiteRepo({ testCommand: "true" });

    await expect(host.connect({ siteDir: site, baseBranch: "main" })).rejects.toThrow(/firebase-tools init hosting/);
    expect(existsSync(join(site, ".github/workflows/publish.yml"))).toBe(false);
  });

  it("writes a workflow that publishes on a merge into the base branch, with the key firebase init stored", async () => {
    const { host } = fakeFirebase();
    const site = firebaseSite();

    await host.connect({ siteDir: site, baseBranch: "trunk" });

    const workflow = readFileSync(join(site, ".github/workflows/publish.yml"), "utf8");
    expect(workflow).toContain("branches: [trunk]");
    expect(workflow).toContain("npx factory publish");
    expect(workflow).toContain("secrets.FIREBASE_SERVICE_ACCOUNT_MY_SITE");
    expect(workflow).not.toMatch(/pull_request/);
  });

  it("refuses to connect next to firebase init's own workflow, which would publish a second time", async () => {
    const { host } = fakeFirebase();
    const site = firebaseSite();
    writeFile(site, ".github/workflows/firebase-hosting-merge.yml", "name: Deploy\n");

    await expect(host.connect({ siteDir: site, baseBranch: "main" })).rejects.toThrow(/firebase-hosting-merge\.yml/);
  });
});

describe("the host contract workflow", () => {
  it("writes no key without the secret, and says why the test is skipped", () => {
    const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/host-contract.yml", import.meta.url)), "utf8");
    const guard = workflow.indexOf('[ -z "$SERVICE_ACCOUNT" ]');

    expect(guard).toBeGreaterThan(-1);
    expect(workflow.indexOf("firebase-key.json")).toBeGreaterThan(guard);
    expect(workflow).toContain("::notice");
  });
});

describe("factory connect-host and factory publish", () => {
  const site = () => {
    const dir = createSiteRepo({ testCommand: "true" });
    commitFile(dir, "index.html", "<h1>main</h1>\n");
    return dir;
  };

  it("connects the host through the command", async () => {
    const host = new FakeHost();
    const dir = site();

    const run = await runFactory(["connect-host"], { cwd: dir, host, tracker: new FakeTracker() });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(host.connected).toEqual([{ siteDir: dir, baseBranch: "main" }]);
    expect(run.stdout).toMatch(/merging into main publishes/);
  });

  it("publishes the base branch and prints the live address", async () => {
    const host = new FakeHost();

    const run = await runFactory(["publish"], { cwd: site(), host, tracker: new FakeTracker() });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain(FakeHost.LIVE_URL);
  });

  it("refuses to publish any other branch: nothing reaches the live Site without Approve", async () => {
    const host = new FakeHost();
    const dir = site();
    git(dir, "checkout", "-q", "-b", "spec/1");

    const run = await runFactory(["publish"], { cwd: dir, host, tracker: new FakeTracker() });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Approve/);
    expect(host.published).toEqual([]);
  });

  it("prints the host's reason and exits 1 when it stops", async () => {
    const dir = createSiteRepo({ testCommand: "true" });

    const run = await runFactory(["connect-host"], { cwd: dir, host: fakeFirebase().host, tracker: new FakeTracker() });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/firebase\.json/);
  });
});

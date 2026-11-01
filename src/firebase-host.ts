import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError, readSiteConfig } from "./config.ts";
import { git, gitSucceeds } from "./git.ts";
import { HostError, type Host } from "./host.ts";
import { buildSite, ServeError } from "./served-build.ts";

/** The longest Firebase keeps a preview channel: a Spec may wait this long for Approve. */
const PREVIEW_EXPIRES = "30d";
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const WORKFLOW = ".github/workflows/publish.yml";
/** What `firebase init` writes when asked to deploy on merge; `factory publish` does that here. */
const FIREBASE_MERGE_WORKFLOW = ".github/workflows/firebase-hosting-merge.yml";

export interface FirebaseHostOptions {
  /** The Firebase CLI, as a command and its first arguments. */
  command?: string[];
  env?: NodeJS.ProcessEnv;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** The project in `.firebaserc`, and the Hosting site in `firebase.json`, which is the project's unless it names one. */
async function readFirebaseSetup(dir: string): Promise<{ project: string; site: string }> {
  const firebaseJson = await readJson(join(dir, "firebase.json"));
  const hosting = [firebaseJson?.hosting].flat()[0] as { site?: unknown } | undefined;
  if (!hosting) throw new HostError("This Site has no firebase.json with a hosting part yet, so Firebase does not know what to publish. Run `npx firebase-tools init hosting` first, and commit what it writes.");
  const firebaserc = await readJson(join(dir, ".firebaserc"));
  const project = (firebaserc?.projects as { default?: unknown } | undefined)?.default;
  if (typeof project !== "string" || project === "") {
    throw new HostError("This Site has no .firebaserc naming its Firebase project yet. Run `npx firebase-tools init hosting` first, and commit what it writes.");
  }
  return { project, site: typeof hosting.site === "string" ? hosting.site : project };
}

/** A branch name as a preview channel: Firebase takes lower-case letters, digits and hyphens. */
function channelOf(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function publishWorkflow(baseBranch: string, project: string): string {
  // The name `firebase init` gives the secret holding the key of the account it creates.
  const secret = `FIREBASE_SERVICE_ACCOUNT_${project.replace(/-/g, "_").toUpperCase()}`;
  return `# Written by \`factory connect-host\`: merging into ${baseBranch} publishes the Site.
name: Publish

on:
  push:
    branches: [${baseBranch}]

# One Publish at a time, so an older merge never overwrites a newer one.
concurrency:
  group: publish
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Hand Firebase the key that init stored on GitHub
        run: printf '%s' "$SERVICE_ACCOUNT" > "$RUNNER_TEMP/firebase-key.json"
        env:
          SERVICE_ACCOUNT: \${{ secrets.${secret} }}
      - run: npx factory publish
        env:
          GOOGLE_APPLICATION_CREDENTIALS: \${{ runner.temp }}/firebase-key.json
`;
}

/**
 * Firebase Hosting, through its CLI. A Preview is a preview channel named after the branch,
 * deployed from the Builder's login; Publish runs on GitHub, from a workflow that uses the
 * service account `firebase init hosting:github` created, so no secret passes through the Builder.
 */
export class FirebaseHost implements Host {
  readonly #command: string[];
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: FirebaseHostOptions = {}) {
    this.#command = options.command ?? ["npx", "--yes", "firebase-tools"];
    this.#env = options.env ?? process.env;
  }

  async connect({ siteDir, baseBranch }: { siteDir: string; baseBranch: string }): Promise<void> {
    const { project } = await readFirebaseSetup(siteDir);
    if (await exists(join(siteDir, FIREBASE_MERGE_WORKFLOW))) {
      throw new HostError(`${FIREBASE_MERGE_WORKFLOW} would publish the Site a second time, next to the Factory's own Publish. Delete that file, then run this command again.`);
    }
    await mkdir(dirname(join(siteDir, WORKFLOW)), { recursive: true });
    await writeFile(join(siteDir, WORKFLOW), publishWorkflow(baseBranch, project));
  }

  async deployPreview({ siteDir, branch }: { siteDir: string; branch: string }): Promise<string> {
    const config = await this.#siteConfig(siteDir);
    const channel = channelOf(branch);
    // Inside the Site, so that the build finds the Site's node_modules; the Site itself stays on its branch.
    const worktree = join(siteDir, ".factory", "worktrees", `preview-${channel}`);
    await removeWorktree(siteDir, worktree);
    await mkdir(dirname(worktree), { recursive: true });
    await git(siteDir, "worktree", "add", "--quiet", "--detach", worktree, branch);
    try {
      await readFirebaseSetup(worktree);
      await this.#build(worktree, config.buildCommand);
      const result = await this.#firebase(worktree, ["hosting:channel:deploy", channel, "--expires", PREVIEW_EXPIRES]);
      const url = Object.values(result as Record<string, { url?: unknown }>)[0]?.url;
      if (typeof url !== "string") throw new HostError(`Firebase deployed the Preview of ${branch} but named no address for it.`);
      return url;
    } finally {
      await removeWorktree(siteDir, worktree);
    }
  }

  async publishLive({ siteDir }: { siteDir: string }): Promise<string> {
    const config = await this.#siteConfig(siteDir);
    const { site } = await readFirebaseSetup(siteDir);
    await this.#build(siteDir, config.buildCommand);
    await this.#firebase(siteDir, ["deploy", "--only", "hosting"]);
    return `https://${site}.web.app`;
  }

  async #siteConfig(siteDir: string) {
    try {
      return await readSiteConfig(siteDir);
    } catch (error) {
      if (error instanceof ConfigError) throw new HostError(error.message);
      throw error;
    }
  }

  async #build(dir: string, command: string | undefined): Promise<void> {
    if (!command) return;
    try {
      await buildSite(dir, command);
    } catch (error) {
      if (error instanceof ServeError) throw new HostError(error.message);
      throw error;
    }
  }

  /** Runs the Firebase CLI with `--json` and returns its `result`, or stops with Firebase's own reason. */
  #firebase(cwd: string, args: string[]): Promise<unknown> {
    const [command, ...first] = this.#command as [string, ...string[]];
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...first, ...args, "--json", "--non-interactive"],
        { cwd, env: this.#env, timeout: DEPLOY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
            reject(new HostError(`The Firebase CLI (${command}) could not be started, so the Factory cannot reach Firebase.`));
            return;
          }
          const answer = parseAnswer(stdout);
          if (!error && answer?.status === "success") resolve(answer.result);
          else reject(new HostError(failure(answer?.error ?? (stderr.trim() || error?.message || stdout.trim()))));
        },
      );
    });
  }
}

function parseAnswer(stdout: string): { status?: string; result?: unknown; error?: string } | undefined {
  try {
    return JSON.parse(stdout) as { status?: string; result?: unknown; error?: string };
  } catch {
    return undefined;
  }
}

function failure(reason: string): string {
  const login = /not logged in|login|credentials|authenticat/i.test(reason) ? " Log in with `npx firebase-tools login`, then run this again." : "";
  return `Firebase refused the deploy: ${reason}${login}`;
}

async function removeWorktree(siteDir: string, worktree: string): Promise<void> {
  if (!(await gitSucceeds(siteDir, "worktree", "remove", "--force", worktree))) await rm(worktree, { recursive: true, force: true });
  await git(siteDir, "worktree", "prune");
}

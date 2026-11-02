import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { readSiteConfig } from "./config.ts";
import { git, gitSucceeds } from "./git.ts";
import { factoryPinAt, GUIDANCE_FOLDER } from "./pins.ts";
import type { FactoryReleases, Release } from "./releases.ts";
import { PipelineError } from "./request.ts";
import type { PullRequest, Tracker } from "./tracker.ts";

const REMOTE = "origin";
/** One branch for every update, so a newer release moves the open pull request on instead of adding a second. */
const UPDATE_BRANCH = "factory-update";
const SKILLS_FOLDER = ".agents/skills";
const DESIGN_FILE = "design/DESIGN.md";

/** npm drops a `.gitignore` from a published package, so the starter's template carries it under this name. */
const TEMPLATE_RENAMES: Record<string, string> = { gitignore: ".gitignore" };

export interface UpdateOptions {
  siteDir: string;
  tracker: Tracker;
  releases: FactoryReleases;
  stdout: (text: string) => void;
}

/**
 * Brings the newest Factory release into the Site as a pull request. All of it happens in a
 * throwaway worktree of what is on GitHub and on a branch only `origin` holds, so the Builder's
 * folder and base branch stay as they are until they merge.
 */
export async function runUpdate({ siteDir, tracker, releases, stdout }: UpdateOptions): Promise<void> {
  const { baseBranch } = await readSiteConfig(siteDir);
  if (!(await gitSucceeds(siteDir, "remote", "get-url", REMOTE))) {
    throw new PipelineError(`This Site has no remote called ${REMOTE}, so an update has nowhere to open its pull request. Nothing was changed.`);
  }
  const base = await remoteTip(siteDir, baseBranch);
  const pinned = await factoryPinAt(siteDir, base);
  if (pinned === undefined) {
    throw new PipelineError(`package.json on ${baseBranch} does not pin the Factory, so there is nothing to update from. Nothing was changed.`);
  }
  const latest = await releases.latest();
  if (!isNewer(latest, pinned)) {
    stdout(`Your Site already has the newest Factory, version ${pinned}. Nothing to do.\n`);
    return;
  }
  const open = await tracker.pullRequestFrom(UPDATE_BRANCH);
  if (open && (await factoryPinOfUpdateBranch(siteDir)) === latest) {
    stdout(`The update to Factory ${latest} is already waiting for you in pull request #${open.number}: ${open.url}\n`);
    return;
  }

  const work = await mkdtemp(join(tmpdir(), "web-factory-update-"));
  try {
    const downloads = [join(work, "from"), join(work, "to")] as const;
    await Promise.all(downloads.map((folder) => mkdir(folder)));
    const from = await releases.fetch(pinned, downloads[0]);
    const to = await releases.fetch(latest, downloads[1]);

    const worktree = join(work, "site");
    await git(siteDir, "worktree", "add", "--quiet", "--detach", worktree, base);
    const files = await bringFiles(worktree, from, to);
    await releases.pin(worktree, latest);
    await commitAll(worktree, `Update the Factory to ${latest}`);
    // The branch is the Factory's own: anything on it is an older update this one replaces.
    await git(worktree, "push", "--quiet", "--force", REMOTE, `HEAD:refs/heads/${UPDATE_BRANCH}`);

    const body = await pullRequestBody({ pinned, latest, from, to, files, worktree });
    const pullRequest = await publish(tracker, open, baseBranch, body);
    stdout(`Pull request #${pullRequest.number} lists what this update changes: ${pullRequest.url}\nNothing in your Site changes until you merge it; merging it is how you approve the update.\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
    await git(siteDir, "worktree", "prune");
  }
}

async function publish(tracker: Tracker, open: PullRequest | undefined, base: string, body: string): Promise<PullRequest> {
  if (!open) return tracker.openPullRequest({ head: UPDATE_BRANCH, base, title: "Update the Factory", body });
  await tracker.updatePullRequest(open.number, { body });
  return open;
}

/** Fetches a branch from `origin` and returns its commit, leaving every local branch where it is. */
async function remoteTip(siteDir: string, branch: string): Promise<string> {
  const ref = `refs/remotes/${REMOTE}/${branch}`;
  await git(siteDir, "fetch", "--quiet", REMOTE, `+refs/heads/${branch}:${ref}`);
  return git(siteDir, "rev-parse", ref);
}

async function factoryPinOfUpdateBranch(siteDir: string): Promise<string | undefined> {
  return factoryPinAt(siteDir, await remoteTip(siteDir, UPDATE_BRANCH));
}

/** Whether version `a` is newer than `b`, by their dotted numbers. */
function isNewer(a: string, b: string): boolean {
  const numbers = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

interface FileChanges {
  /** Files this update added, changed or removed, as Site paths. */
  applied: string[];
  /** Files the release changed that the Site had changed itself; they stay as the Site has them. */
  kept: string[];
  /** Every file of each release, as Site paths, each with where it lies in that release. */
  before: Map<string, string>;
  after: Map<string, string>;
}

/**
 * Compares the two releases and brings over only what changed between them, so a file the Site
 * changed itself, such as AGENTS.md at Kickoff, is never overwritten by a file it did not ask for.
 */
async function bringFiles(worktree: string, from: Release, to: Release): Promise<FileChanges> {
  const [before, after] = [await templateFiles(from.template), await templateFiles(to.template)];
  const applied: string[] = [];
  const kept: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const [old, next, site] = await Promise.all([content(before.get(path)), content(after.get(path)), content(join(worktree, path))]);
    if (same(old, next) || same(site, next)) continue;
    if (!same(site, old)) {
      kept.push(path);
      continue;
    }
    await rm(join(worktree, path), { force: true });
    const source = after.get(path);
    if (source !== undefined) {
      await mkdir(dirname(join(worktree, path)), { recursive: true });
      await copyFile(source, join(worktree, path));
    }
    applied.push(path);
  }
  return { applied: applied.sort(), kept: kept.sort(), before, after };
}

async function templateFiles(template: string): Promise<Map<string, string>> {
  const entries = await readdir(template, { withFileTypes: true, recursive: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = relative(template, file);
    files.set(TEMPLATE_RENAMES[path] ?? path, file);
  }
  return files;
}

async function content(path: string | undefined): Promise<Buffer | undefined> {
  if (path === undefined) return undefined;
  return readFile(path).catch(() => undefined);
}

function same(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.equals(b);
}

async function commitAll(worktree: string, message: string): Promise<void> {
  await git(worktree, "add", "-A");
  const identity = await git(worktree, "config", "user.email").then(
    () => [],
    () => ["-c", "user.name=web-factory", "-c", "user.email=web-factory@users.noreply.github.com"],
  );
  await git(worktree, ...identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function skillOf(path: string): string | undefined {
  return path.startsWith(`${SKILLS_FOLDER}/`) ? path.split("/")[2] : undefined;
}

/** The skills this update touched, each as added, changed or removed by the release. */
function skillChanges({ applied, before, after }: FileChanges, guidanceMoved: boolean) {
  const has = (files: Map<string, string>, skill: string) => [...files.keys()].some((path) => skillOf(path) === skill);
  const skills = [...new Set(applied.flatMap((path) => skillOf(path) ?? []))].filter((skill) => !(guidanceMoved && `${SKILLS_FOLDER}/${skill}` === GUIDANCE_FOLDER));
  return {
    added: skills.filter((skill) => !has(before, skill)),
    removed: skills.filter((skill) => !has(after, skill)),
    changed: skills.filter((skill) => has(before, skill) && has(after, skill)),
  };
}

async function pullRequestBody(update: { pinned: string; latest: string; from: Release; to: Release; files: FileChanges; worktree: string }): Promise<string> {
  const { pinned, latest, from, to, files, worktree } = update;
  const guidanceMoved = from.modernWebGuidance !== to.modernWebGuidance;
  const skills = skillChanges(files, guidanceMoved);
  const list = (title: string, items: string[]) => (items.length > 0 ? [`- ${title}: ${items.join(", ")}`] : []);
  const moved = (title: string, was: string, now: string) => (was === now ? [] : [`- ${title}: ${was} → ${now}`]);
  const formatMoved = from.designFormat !== to.designFormat;
  const hasDesign = await lstat(join(worktree, DESIGN_FILE)).then(() => true, () => false);

  return [
    "This pull request updates the Factory in your Site. Nothing changes until you merge it: merging it is how you approve the update.",
    "",
    "## What changes",
    "",
    ...moved("Factory", pinned, latest),
    ...moved("Modern Web Guidance", from.modernWebGuidance, to.modernWebGuidance),
    ...moved("DESIGN.md format", from.designFormat, to.designFormat),
    ...list("New skills", skills.added),
    ...list("Changed skills", skills.changed),
    ...list("Removed skills", skills.removed),
    ...list("New Review checks", to.reviewChecks.filter((check) => !from.reviewChecks.includes(check))),
    ...list("Removed Review checks", from.reviewChecks.filter((check) => !to.reviewChecks.includes(check))),
    ...list("Other files", files.applied.filter((path) => skillOf(path) === undefined)),
    ...(files.kept.length > 0
      ? ["", "## Kept as your Site has them", "", "This release changed these files, but your Site had changed them too, so they stay as they are. Compare them with the new release if you want its version:", "", ...files.kept.map((path) => `- ${path}`)]
      : []),
    "",
    "## After you merge",
    "",
    "Run `npm install` in your Site's folder. It puts the new Factory on your computer. You should see a short summary of added or changed packages.",
    ...(formatMoved && hasDesign ? ["", `Your ${DESIGN_FILE} is written in format ${from.designFormat}. Until it is rewritten in format ${to.designFormat}, its Review check fails: ask the design skill to rewrite it.`] : []),
    "",
  ].join("\n");
}

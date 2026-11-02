import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Factory package a Site depends on. */
const FACTORY_PACKAGE = "@fabkrum/web-factory";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(PACKAGE_ROOT, "template");

/** npm drops a `.gitignore` from a published package, so the template carries it under this name. */
const TEMPLATE_RENAMES: Record<string, string> = { gitignore: ".gitignore" };

/** Used only for the first commit, on a machine where git does not know the Builder's name yet. */
const FALLBACK_IDENTITY = ["-c", "user.name=web-factory", "-c", "user.email=web-factory@users.noreply.github.com"];

const USAGE = `Usage: npm create web-factory@latest <folder>

Creates a Site repository in <folder>, with the Factory inside. Safe to run twice:
it adds only what is missing and never changes what is there.
`;

export interface CreateDeps {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** A step that failed for a reason the Builder can read; the message is printed as it is. */
class CreateError extends Error {}

/** The `create-web-factory` command. Returns its exit code. */
export async function createSite(argv: string[], deps: CreateDeps): Promise<number> {
  const [folder, ...rest] = argv;
  if (folder === "--help" || folder === "-h") {
    deps.stdout(USAGE);
    return 0;
  }
  if (folder === undefined || folder.startsWith("-") || rest.length > 0) {
    deps.stderr(USAGE);
    return 2;
  }
  const site = resolve(deps.cwd, folder);
  try {
    await refuseSomeoneElsesFolder(site);
    await requireGit();
    const added = await addMissingFiles(site);
    const initialised = await initialiseGit(site);
    const installed = await installFactory(site, deps);
    const committed = await commitFirstVersion(site);
    if (added.length === 0 && !initialised && !installed && !committed) {
      deps.stdout(`Nothing to do: ${site} is already a Site.\n`);
    } else {
      deps.stdout(`Your Site is ready in ${site}.\n`);
      if (!committed && added.length > 0) deps.stdout(`Put back what was missing, not yet committed: ${added.join(", ")}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof CreateError)) throw error;
    deps.stderr(`${error.message}\n`);
    return 1;
  }
}

/** Only an empty folder or an earlier run's Site is written to, so nobody's work gets mixed in. */
async function refuseSomeoneElsesFolder(site: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(site);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CreateError(`${site} cannot be used as a folder for a Site: ${(error as Error).message}`);
  }
  if (entries.every((entry) => entry === ".git")) return;
  if (!(await dependsOnFactory(site))) {
    throw new CreateError(`${site} already holds files and is not a Site, so nothing was changed. Choose a new folder name.`);
  }
}

async function dependsOnFactory(site: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(site, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    return manifest.devDependencies?.[FACTORY_PACKAGE] !== undefined;
  } catch {
    return false;
  }
}

async function requireGit(): Promise<void> {
  try {
    await run("git", ["--version"]);
  } catch {
    throw new CreateError("git is not installed, and a Site is a git repository. Install git, then run this command again.");
  }
}

/**
 * Writes every file a Site starts with that is not there yet and leaves the others alone.
 * package.json comes first: it is what tells a later run that this folder is a Site.
 * Returns what it added.
 */
async function addMissingFiles(site: string): Promise<string[]> {
  await mkdir(site, { recursive: true });
  const added: string[] = [];
  const add = async (path: string, write: (target: string) => Promise<void>): Promise<void> => {
    const target = join(site, path);
    if (await exists(target)) return;
    await mkdir(dirname(target), { recursive: true });
    // Through a temporary name, so a run cut short never leaves half a file that counts as there.
    await write(`${target}.tmp`);
    await rename(`${target}.tmp`, target);
    added.push(path);
  };

  await add("package.json", async (target) => writeFile(target, await siteManifest(site)));
  await add("README.md", (target) => writeFile(target, `# ${basename(site)}\n`));
  for (const file of await templateFiles(TEMPLATE)) {
    const path = relative(TEMPLATE, file);
    await add(TEMPLATE_RENAMES[path] ?? path, (target) => copyFile(file, target));
  }
  await add(join(".claude", "skills"), (target) => symlink(join("..", ".agents", "skills"), target));
  return added;
}

/** The Site's package.json. The Factory is pinned to exactly this package's version: the two are released together. */
async function siteManifest(site: string): Promise<string> {
  const { version } = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
  const manifest = { name: packageName(site), private: true, scripts: { board: "factory board" }, devDependencies: { [FACTORY_PACKAGE]: version } };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function packageName(site: string): string {
  const name = basename(site).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "");
  return name === "" ? "site" : name;
}

async function templateFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function initialiseGit(site: string): Promise<boolean> {
  if (await exists(join(site, ".git"))) return false;
  await run("git", ["init", "-q", "-b", "main"], { cwd: site });
  return true;
}

async function installFactory(site: string, deps: CreateDeps): Promise<boolean> {
  if (await exists(join(site, "node_modules", ".bin", "factory"))) return false;
  deps.stdout("Installing the Factory. This can take a few minutes.\n");
  try {
    await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: site, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const reason = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").slice(-3).join("\n");
    throw new CreateError(`Installing the Factory did not work, often because of the network. Run this same command again: it continues where it stopped.\n${reason}`);
  }
  return true;
}

/** The Site's first commit. A Site that has one is the Builder's: nothing here commits to it again. */
async function commitFirstVersion(site: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: site });
    return false;
  } catch {
    // No commit yet, which is what this step is for.
  }
  const hasIdentity = await run("git", ["config", "user.email"], { cwd: site }).then(
    () => true,
    () => false,
  );
  await run("git", ["add", "-A"], { cwd: site });
  await run("git", [...(hasIdentity ? [] : FALLBACK_IDENTITY), "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Start the Site with the Factory"], { cwd: site });
  return true;
}

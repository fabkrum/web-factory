import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSite } from "../packages/create-web-factory/src/create-site.ts";
import { serveFakePackageRegistry, type FakePackageRegistry } from "./harness/fake-package-registry.ts";
import { git, writeFile } from "./harness/site-repo.ts";

const REPOSITORY = resolve(import.meta.dirname, "..");
const STARTER = join(REPOSITORY, "packages", "create-web-factory");
const FACTORY_VERSION = (JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { version: string }).version;

/** Runs a command without blocking this process, which also hosts the fake registry that command talks to. */
function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(command, args, { ...options, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ status: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function packDirectory(from: string, env: NodeJS.ProcessEnv, into: string): string {
  mkdirSync(into);
  execFileSync("npm", ["pack", "--pack-destination", into], { cwd: from, env, stdio: "ignore" });
  const [tarball] = readdirSync(into);
  return join(into, tarball as string);
}

/** Every file's content, without what npm and git keep for themselves. */
function fingerprint(site: string): string {
  const files = readdirSync(site, { recursive: true, encoding: "utf8" }).filter((path) => !/^(node_modules|\.git)(\/|$)/.test(path) && lstatSync(join(site, path)).isFile());
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update(readFileSync(join(site, file)));
  return hash.digest("hex");
}

describe("npm create web-factory", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let registry: FakePackageRegistry;

  const create = (folder: string) => runCommand("npm", ["create", "--yes", "web-factory@latest", folder], { cwd: root, env });
  const read = (site: string, path: string) => readFileSync(join(site, path), "utf8");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "web-factory-create-"));
    // A machine with nothing set up: no git identity, no npm cache, nothing inherited from a surrounding npm run.
    const home = join(root, "home");
    mkdirSync(home);
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_")));
    Object.assign(env, { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false" });
    const packs = join(root, "packs");
    mkdirSync(packs);
    const factory = packDirectory(REPOSITORY, env, join(packs, "factory"));
    const starter = packDirectory(STARTER, env, join(packs, "starter"));
    // The fake registry serves the Factory's own files only; what they import resolves here.
    symlinkSync(join(REPOSITORY, "node_modules"), join(root, "node_modules"));
    registry = await serveFakePackageRegistry([{ tarball: starter }, { tarball: factory, withoutDependencies: true }]);
    env.npm_config_registry = registry.url;
  });

  afterAll(async () => {
    await registry?.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("in a new folder", () => {
    let site: string;

    beforeAll(async () => {
      site = join(root, "My Site");
      const result = await create("My Site");
      expect(result.stderr).not.toMatch(/npm error/);
      expect(result.status).toBe(0);
    });

    it("pins the Factory and leaves a working factory command", () => {
      const manifest = JSON.parse(read(site, "package.json")) as { name: string; devDependencies: Record<string, string> };
      expect(manifest.name).toBe("my-site");
      expect(manifest.devDependencies["@fabkrum/web-factory"]).toBe(FACTORY_VERSION);
      const lock = JSON.parse(read(site, "package-lock.json")) as { packages: Record<string, { version: string }> };
      expect(lock.packages["node_modules/@fabkrum/web-factory"]?.version).toBe(FACTORY_VERSION);

      const help = spawnSync("./node_modules/.bin/factory", ["--help"], { cwd: site, env, encoding: "utf8" });
      expect(help.stderr).toBe("");
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("factory loop <spec>");
    });

    it("commits the Site to main, without what npm installed", () => {
      expect(git(site, "branch", "--show-current")).toBe("main");
      expect(git(site, "status", "--porcelain")).toBe("");
      const tracked = git(site, "ls-files").split("\n");
      expect(tracked).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md", ".gitignore", "package-lock.json", ".gemini/settings.json", ".claude/skills"]));
      expect(tracked.filter((path) => path.startsWith("node_modules/"))).toEqual([]);
      expect(read(site, ".gitignore")).toMatch(/^\.factory\/$/m);
    });

    it("lets every Agent CLI find the same instructions and skills", () => {
      expect(existsSync(join(site, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(site, ".agents/skills/modern-web-guidance/SKILL.md"))).toBe(true);
      for (const skill of ["kickoff", "request", "spec", "design", "import-stitch", "import-figma", "import-claude-design"]) expect(read(site, `.agents/skills/${skill}/SKILL.md`)).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
      expect(read(site, "CLAUDE.md").split("\n")).toContain("@AGENTS.md");
      expect(lstatSync(join(site, ".claude/skills")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(site, ".claude/skills"))).toBe("../.agents/skills");
      expect(read(site, ".claude/skills/modern-web-guidance/SKILL.md")).toBe(read(site, ".agents/skills/modern-web-guidance/SKILL.md"));
      const gemini = JSON.parse(read(site, ".gemini/settings.json")) as { context: { fileName: string[] } };
      expect(gemini.context.fileName).toContain("AGENTS.md");
    });

    it("vendors Modern Web Guidance at its pinned version, with its licence and notice", () => {
      const skill = ".agents/skills/modern-web-guidance";
      expect(read(site, `${skill}/LICENSE`)).toContain("Apache License");
      expect(read(site, `${skill}/NOTICE`)).toContain("version 0.0.196");
      expect(read(site, `${skill}/THIRD_PARTY_NOTICES`)).toContain("@tensorflow/tfjs-core");
      expect(read(site, "THIRD-PARTY-NOTICES.md")).toMatch(/Modern Web Guidance[\s\S]*0\.0\.196[\s\S]*Apache License 2\.0/);
    });

    it("runs the vendored Modern Web Guidance itself, never a newer version from npm", () => {
      const skill = read(site, ".agents/skills/modern-web-guidance/SKILL.md");
      expect(skill).not.toContain("@latest");
      const list = spawnSync("node", [".agents/skills/modern-web-guidance/modern-web.mjs", "retrieve", "dialog"], { cwd: site, env: { ...env, DISABLE_TELEMETRY: "1" }, encoding: "utf8" });
      expect(list.status).toBe(0);
      expect(list.stdout).toContain("Guide for dialog");
    });

    it("gives the agent the rules for the Builder in AGENTS.md", () => {
      const agents = read(site, "AGENTS.md");
      expect(agents).toMatch(/Modern Web Guidance[\s\S]*required reading in the Spec, Design and Build Stages/);
      expect(agents).toMatch(/Answer the Builder in the Builder's language/);
      expect(agents).toMatch(/Everything in the repository stays in English/);
      expect(agents).toMatch(/exactly one command/);
      expect(agents).toMatch(/before the Builder runs it/);
      expect(agents).toMatch(/what the Builder should see afterwards/);
    });

    it("changes nothing on a second run, and keeps what the Builder changed since", async () => {
      writeFile(site, "AGENTS.md", `${read(site, "AGENTS.md")}\nStack: plain HTML.\n`);
      git(site, "add", "AGENTS.md");
      git(site, "-c", "user.name=Test Builder", "-c", "user.email=builder@example.com", "commit", "-q", "-m", "Record the stack");
      writeFile(site, "work-in-progress.txt", "not committed yet\n");
      const before = { head: git(site, "rev-parse", "HEAD"), status: git(site, "status", "--porcelain"), files: fingerprint(site) };

      const second = await create("My Site");

      expect(second.status).toBe(0);
      expect(second.stdout).toContain("Nothing to do");
      expect({ head: git(site, "rev-parse", "HEAD"), status: git(site, "status", "--porcelain"), files: fingerprint(site) }).toEqual(before);
    });
  });

  it("finishes a run that was cut short", async () => {
    const site = join(root, "half-done");
    expect((await create("half-done")).status).toBe(0);
    // As a run looks when it stopped before it finished copying, installing and committing.
    rmSync(join(site, ".git"), { recursive: true });
    rmSync(join(site, "node_modules"), { recursive: true });
    rmSync(join(site, "AGENTS.md"));
    rmSync(join(site, ".claude"), { recursive: true });

    const second = await create("half-done");

    expect(second.status).toBe(0);
    expect(existsSync(join(site, "AGENTS.md"))).toBe(true);
    expect(lstatSync(join(site, ".claude/skills")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(site, "node_modules/.bin/factory"))).toBe(true);
    expect(git(site, "status", "--porcelain")).toBe("");
    expect(git(site, "log", "--format=%s")).toBe("Start the Site with the Factory");
  });
});

describe("create-web-factory refuses", () => {
  const run = async (argv: string[], cwd = tmpdir()) => {
    let stdout = "";
    let stderr = "";
    const exitCode = await createSite(argv, { cwd, stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text) });
    return { exitCode, stdout, stderr };
  };

  it("a folder with someone else's files, and changes nothing in it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "web-factory-occupied-"));
    writeFileSync(join(folder, "thesis.txt"), "mine\n");

    const result = await run([folder]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a Site");
    expect(readdirSync(folder)).toEqual(["thesis.txt"]);
    rmSync(folder, { recursive: true });
  });

  it("a run without a folder name, and says how to use it", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("npm create web-factory@latest <folder>");
  });
});

it("releases the starter and the Factory at one version, since the starter pins its own", () => {
  const starter = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf8")) as { version: string };
  expect(starter.version).toBe(FACTORY_VERSION);
});

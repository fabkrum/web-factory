import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const INSTALLER = resolve(import.meta.dirname, "..", "install.sh");
const NODE_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const GH_ARCH = process.arch === "arm64" ? "arm64" : "amd64";
const MAC = process.platform === "darwin";

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** Stands in for the internet: serves the fixtures by file name and logs what was asked for. */
const FAKE_CURL = `
out=""; url=""; effective=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w) effective=1; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "curl $url" >>"$FAKE_LOG"
if [ -n "$effective" ]; then printf 'https://github.com/cli/cli/releases/tag/v2.99.0'; exit 0; fi
if [ -n "\${CURL_DAMAGES:-}" ]; then case "$url" in *"$CURL_DAMAGES"*) echo damaged >"$out"; exit 0 ;; esac; fi
cp "$FAKE_FIXTURES/$(basename "$url")" "$out"
`;

/** The npm inside the fake Node download: installs Agent CLIs that work, and creates a Site. */
const FAKE_NPM = `
echo "npm $*" >>"$FAKE_LOG"
case "$1" in
  --version) echo 10.0.0 ;;
  install)
    while [ "$1" != "--prefix" ]; do shift; done
    mkdir -p "$2/bin"
    for command in claude codex gemini; do printf '#!/bin/sh\\nexit 0\\n' >"$2/bin/$command"; chmod +x "$2/bin/$command"; done
    ;;
  create)
    if [ -e "$FAKE_FIXTURES/../create-fails" ]; then echo "Creating failed" >&2; exit 1; fi
    for site; do :; done
    mkdir -p "$site"
    echo "{}" >"$site/package.json"
    ;;
esac
`;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildFixtures(root: string): string {
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures);

  const nodeName = `node-v22.99.0-${MAC ? "darwin" : "linux"}-${NODE_ARCH}`;
  const nodeBin = join(root, "unpacked", nodeName, "bin");
  mkdirSync(nodeBin, { recursive: true });
  script(join(nodeBin, "node"), `[ "$1" = --version ] && echo v22.99.0`);
  script(join(nodeBin, "npm"), FAKE_NPM);
  execFileSync("tar", ["-czf", join(fixtures, `${nodeName}.tar.gz`), "-C", join(root, "unpacked"), nodeName]);
  writeFileSync(join(fixtures, "SHASUMS256.txt"), `${sha256(join(fixtures, `${nodeName}.tar.gz`))}  ${nodeName}.tar.gz\n0000  node-v22.99.0-other-thing.tar.gz\n`);

  const ghName = `gh_2.99.0_${MAC ? "macOS" : "linux"}_${GH_ARCH}`;
  const ghFile = `${ghName}.${MAC ? "zip" : "tar.gz"}`;
  const ghBin = join(root, "unpacked", ghName, "bin");
  mkdirSync(ghBin, { recursive: true });
  script(join(ghBin, "gh"), "exit 0");
  if (MAC) execFileSync("zip", ["-qr", join(fixtures, ghFile), ghName], { cwd: join(root, "unpacked") });
  else execFileSync("tar", ["-czf", join(fixtures, ghFile), "-C", join(root, "unpacked"), ghName]);
  writeFileSync(join(fixtures, "gh_2.99.0_checksums.txt"), `${sha256(join(fixtures, ghFile))}  ${ghFile}\n`);

  // The one the Antigravity path downloads; this repository's own installer has the same name.
  script(join(fixtures, "install.sh"), `mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\nexit 0\\n' >"$HOME/.local/bin/agy"; chmod +x "$HOME/.local/bin/agy"`);
  return fixtures;
}

describe("the installer", () => {
  let root: string;
  let fixtures: string;
  let bin: string;
  let home: string;
  let work: string;
  let log: string;

  const site = () => join(work, "my-site");
  const unfinished = () => join(home, ".web-factory", "unfinished");

  /** detached: the run has no terminal to ask in, as in CI. */
  const install = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const spawnOptions = {
      cwd: options.cwd ?? work,
      detached: true,
      encoding: "utf8" as const,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: "/bin/zsh", FAKE_LOG: log, FAKE_FIXTURES: fixtures, ...options.env },
    };
    const result = spawnSync("sh", [INSTALLER, ...args], spawnOptions);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  /** Every file under the home folder and the Site, with its content. */
  const snapshot = (): string[] =>
    [home, work].flatMap((top) =>
      readdirSync(top, { recursive: true, encoding: "utf8" })
        .filter((path) => lstatSync(join(top, path)).isFile())
        .map((path) => `${join(top, path)} ${sha256(join(top, path))}`)
        .sort(),
    );

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "web-factory-installer-"));
    fixtures = buildFixtures(root);
    // What is on the machine already: a Node too old for the Factory and a GitHub CLI that is broken.
    bin = join(root, "bin");
    mkdirSync(bin);
    script(join(bin, "curl"), FAKE_CURL);
    script(join(bin, "node"), `echo v18.0.0`);
    script(join(bin, "gh"), "exit 1");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    rmSync(join(root, "create-fails"), { force: true });
    const run = mkdtempSync(join(root, "run-"));
    home = join(run, "home");
    work = join(run, "work");
    mkdirSync(home);
    mkdirSync(work);
    log = join(run, "log");
    writeFileSync(log, "");
  });

  it("installs what is missing or broken, then creates the Site", () => {
    const result = install(["--agent", "codex", "my-site"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".web-factory/tools/node/bin/node"))).toBe(true);
    expect(existsSync(join(home, ".web-factory/tools/gh/bin/gh"))).toBe(true);
    expect(existsSync(join(home, ".web-factory/tools/npm/bin/codex"))).toBe(true);
    expect(existsSync(join(site(), "package.json"))).toBe(true);
    expect(existsSync(unfinished())).toBe(false);
    expect(result.stdout).toContain("next");
  });

  it("changes nothing and downloads nothing when it runs a second time", () => {
    expect(install(["--agent", "codex", "my-site"]).status).toBe(0);
    const before = snapshot();
    writeFileSync(log, "");

    const second = install(["--agent", "codex", "my-site"]);

    expect(second.status).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(log, "utf8")).not.toMatch(/^curl |npm install/m);
  });

  it("adds the tools to new terminal windows exactly once", () => {
    install(["--agent", "codex", "my-site"]);
    install(["--agent", "codex", "my-site"]);

    for (const file of [".zshrc", ".profile"]) {
      expect(readFileSync(join(home, file), "utf8").match(/\.web-factory\/tools/g)?.length).toBe(3);
      expect(readFileSync(join(home, file), "utf8").match(/# web-factory$/gm)?.length).toBe(1);
    }
  });

  it("installs Antigravity CLI through Google's installer", () => {
    const result = install(["--agent", "antigravity", "my-site"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".local/bin/agy"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("curl https://antigravity.google/cli/install.sh");
  });

  it("notices a half-finished run and finishes it, with the folder and Agent CLI it was given", () => {
    const tools = join(home, ".web-factory/tools");
    mkdirSync(join(tools, "node.partial"), { recursive: true });
    writeFileSync(join(tools, "node.partial", "half"), "half a download");
    mkdirSync(join(tools, "gh/bin"), { recursive: true });
    script(join(tools, "gh/bin/gh"), "exit 1");
    writeFileSync(unfinished(), `site=${site()}\nagent=gemini\n`);
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);

    const result = install([], { cwd: elsewhere });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("did not finish");
    expect(existsSync(join(tools, "node.partial"))).toBe(false);
    expect(readFileSync(log, "utf8")).toMatch(/gh_2\.99\.0_checksums/);
    expect(spawnSync(join(tools, "gh/bin/gh")).status).toBe(0);
    expect(existsSync(join(tools, "npm/bin/gemini"))).toBe(true);
    expect(existsSync(join(site(), "package.json"))).toBe(true);
    expect(existsSync(unfinished())).toBe(false);
  });

  it("refuses a damaged download, leaves no broken tool, and the next run repairs it", () => {
    const first = install(["--agent", "codex", "my-site"], { env: { CURL_DAMAGES: "tar.gz" } });

    expect(first.status).toBe(1);
    expect(first.stderr).toContain("damaged");
    expect(first.stderr).toContain("Run the same command again");
    expect(existsSync(join(home, ".web-factory/tools/node"))).toBe(false);
    expect(existsSync(unfinished())).toBe(true);

    const second = install(["--agent", "codex", "my-site"]);

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("did not finish");
    expect(existsSync(join(home, ".web-factory/downloads.partial"))).toBe(false);
    expect(existsSync(join(site(), "package.json"))).toBe(true);
  });

  it("stays unfinished when creating the Site fails, and the next run finishes it", () => {
    writeFileSync(join(root, "create-fails"), "");
    const first = install(["--agent", "codex", "my-site"]);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain("Creating failed");
    expect(existsSync(unfinished())).toBe(true);

    rmSync(join(root, "create-fails"));
    const second = install([]);

    expect(second.status).toBe(0);
    expect(existsSync(join(site(), "package.json"))).toBe(true);
    expect(existsSync(unfinished())).toBe(false);
  });

  it("has no default Agent CLI: without a terminal to ask in, it stops and changes nothing", () => {
    const result = install(["my-site"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no default");
    expect(snapshot()).toEqual([]);
  });

  it("refuses an Agent CLI the Factory does not know", () => {
    const result = install(["--agent", "copilot", "my-site"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("copilot");
  });

  describe("on Linux", () => {
    /** A Linux machine with everything but the sandbox's tools, and an apt-get that installs them. */
    const linux = (options: { aptInstallsNothing?: boolean; toolsThere?: boolean } = {}) => {
      const fake = mkdtempSync(join(root, "linux-"));
      script(join(fake, "uname"), `if [ "$1" = -m ]; then echo x86_64; else echo Linux; fi`);
      script(join(fake, "git"), "exit 0");
      script(join(fake, "node"), "echo v22.99.0");
      script(join(fake, "npm"), FAKE_NPM);
      script(join(fake, "gh"), "exit 0");
      script(join(fake, "claude"), "exit 0");
      script(join(fake, "codex"), "exit 0");
      script(join(fake, "sudo"), `exec "$@"`);
      script(join(fake, "dpkg"), "exit 0");
      const tools = ["bwrap", "socat"];
      // Broken rather than absent unless wanted, so the machine running this test cannot lend its own.
      for (const tool of tools) script(join(fake, tool), options.toolsThere ? "exit 0" : "exit 1");
      const installs = tools.map((tool) => `printf '#!/bin/sh\\nexit 0\\n' >"${fake}/${tool}"; chmod +x "${fake}/${tool}"`).join("; ");
      script(join(fake, "apt-get"), `echo "apt-get $*" >>"$FAKE_LOG"; [ "$1" = install ] || exit 0; ${options.aptInstallsNothing ? "exit 0" : installs}`);
      return { PATH: `${fake}:/usr/bin:/bin` };
    };

    it("installs what Claude Code's sandbox runs on", () => {
      const result = install(["--agent", "claude-code", "my-site"], { env: linux() });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("bubblewrap and socat");
      expect(readFileSync(log, "utf8")).toMatch(/^apt-get install .*bubblewrap socat$/m);
    });

    it("changes nothing when those tools work already", () => {
      const result = install(["--agent", "claude-code", "my-site"], { env: linux({ toolsThere: true }) });

      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8")).not.toContain("apt-get");
    });

    it("leaves them out for an Agent CLI that does not need them", () => {
      const result = install(["--agent", "codex", "my-site"], { env: linux() });

      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8")).not.toContain("apt-get");
    });

    it("stays unfinished when they do not install, rather than leave a Claude Code that cannot start", () => {
      const result = install(["--agent", "claude-code", "my-site"], { env: linux({ aptInstallsNothing: true }) });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("bubblewrap and socat did not install");
      expect(result.stderr).toContain("Run the same command again");
      expect(existsSync(unfinished())).toBe(true);
    });
  });

  it("says native Windows is not supported and points to the ways that work", () => {
    const windows = join(root, "windows");
    mkdirSync(windows, { recursive: true });
    script(join(windows, "uname"), "echo MINGW64_NT-10.0");

    const result = install(["--agent", "codex", "my-site"], { env: { PATH: `${windows}:${bin}:/usr/bin:/bin` } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Native Windows is not supported");
    expect(result.stderr).toContain("WSL");
    expect(snapshot()).toEqual([]);
  });
});

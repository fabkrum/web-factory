import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./harness/site-repo.ts";

const REPOSITORY = resolve(import.meta.dirname, "..");
const CHECK = join(REPOSITORY, "scripts", "check-personal.mjs");

const check = (cwd: string) => spawnSync("node", [CHECK], { cwd, encoding: "utf8" });

describe("the check for anything personal", () => {
  let repository: string;

  const track = (path: string, content: string) => {
    writeFileSync(join(repository, path), content);
    git(repository, "add", "-A");
  };

  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), "web-factory-personal-"));
    git(repository, "init", "-q");
  });

  afterEach(() => rmSync(repository, { recursive: true, force: true }));

  it("passes this repository", () => {
    const result = check(REPOSITORY);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["the maintainer's name", "Ask Fabian about this."],
    ["the maintainer's account", "See github.com/fabkrum/other-repository, it is fabkrum's."],
    ["a mail address", "fabian.krumbholz@example.com"],
    ["a home path", "cd /Users/someone/projects"],
    ["Speed Kit", "Works like Speed Kit does."],
    ["Speed Kit in one word", "speedkit-config"],
    ["an fk: skill", "Run fk:write-guide first."],
    ["Warp", "Open a Warp window."],
    ["launchd", "A launchd job starts it."],
    ["caffeinate", "Run it under caffeinate."],
    ["the operator attestation", "Sign the operator attestation."],
  ])("fails on %s, and says where", (_name, line) => {
    track("notes.md", `A clean line.\n${line}\n`);

    const result = check(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("notes.md:2");
  });

  it("fails on a personal word in a file's name", () => {
    track("speed-kit-notes.md", "clean\n");
    expect(check(repository).status).toBe(1);
  });

  it("passes the public names, the licence's holder and WebAuthn's attestation", () => {
    track("package.md", "Install @fabkrum/web-factory from github.com/fabkrum/web-factory, as fabkrum-web-factory-1.0.0.tgz.\n");
    track("LICENSE", "Copyright (c) 2026 Fabian Krumbholz\n");
    track("passkeys.md", "The Authenticator Attestation GUID.\n");

    const result = check(repository);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails on the maintainer's name anywhere else in a licence", () => {
    track("LICENSE", "Copyright (c) 2026 Fabian Krumbholz\nWrite to Fabian.\n");
    expect(check(repository).stderr).toContain("LICENSE:2");
  });
});

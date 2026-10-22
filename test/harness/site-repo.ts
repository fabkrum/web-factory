import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function writeFile(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** Writes a file and commits it, the way a Build session does its work. */
export function commitFile(dir: string, path: string, content: string, message = `Add ${path}`): string {
  writeFile(dir, path, content);
  git(dir, "add", path);
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A throwaway Site repository on `main` with its Factory config committed. */
export function createSiteRepo(config: { testCommand: string; maxAttempts?: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "web-factory-site-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test Builder");
  git(dir, "config", "user.email", "builder@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFile(dir, "factory.json", `${JSON.stringify(config, null, 2)}\n`);
  commitFile(dir, "README.md", "# A Site\n", "Start the Site");
  git(dir, "add", "factory.json");
  git(dir, "commit", "-q", "-m", "Add the Factory config");
  return dir;
}

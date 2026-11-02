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

/** A server that answers everything, on the port the Ticket loop gives it. */
const ANSWERING_SERVER = `node -e "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)"`;

export interface SiteRepoConfig {
  testCommand: string;
  maxAttempts?: number;
  buildCommand?: string;
  /** Null leaves it out of factory.json, as a Site from before this field would. */
  serveCommand?: string | null;
  serveTimeoutMs?: number;
  localePack?: string;
}

/** A throwaway Site repository on `main` with its Factory config committed, and a bare `origin` it pushes to. */
export function createSiteRepo({ serveCommand = ANSWERING_SERVER, ...rest }: SiteRepoConfig): string {
  const config = serveCommand === null ? rest : { ...rest, serveCommand };
  const dir = mkdtempSync(join(tmpdir(), "web-factory-site-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test Builder");
  git(dir, "config", "user.email", "builder@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFile(dir, "factory.json", `${JSON.stringify(config, null, 2)}\n`);
  commitFile(dir, "README.md", "# A Site\n", "Start the Site");
  git(dir, "add", "factory.json");
  git(dir, "commit", "-q", "-m", "Add the Factory config");
  const origin = mkdtempSync(join(tmpdir(), "web-factory-origin-"));
  git(origin, "init", "-q", "--bare");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "main");
  return dir;
}

/** The commit a branch points at in the Site's `origin`, or undefined when `origin` does not have it. */
export function originBranch(site: string, branch: string): string | undefined {
  const line = git(site, "ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  return line === "" ? undefined : line.split(/\s/)[0];
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Runs a git command whose exit code is its answer. */
export async function gitSucceeds(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitSucceeds(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
}

/** The branch checked out in `cwd`; empty on a detached HEAD. */
export function currentBranch(cwd: string): Promise<string> {
  return git(cwd, "branch", "--show-current");
}

/** The worktree that has the branch checked out, if any. */
export async function worktreeOf(cwd: string, branch: string): Promise<string | undefined> {
  const list = await git(cwd, "worktree", "list", "--porcelain");
  let path: string | undefined;
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

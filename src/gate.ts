import { spawn } from "node:child_process";
import { git } from "./git.ts";

/** A green gate names the commit it tested, so that exact commit is what gets merged. */
export type GateResult = { passed: true; head: string } | { passed: false; reason: string };

const OUTPUT_TAIL_LINES = 30;

/**
 * The gate the script decides, not the model: the session committed something
 * on the Ticket's branch, the Site's test command is green, and after the tests
 * nothing is left uncommitted.
 */
export async function runGate(worktree: string, base: string, branch: string, testCommand: string): Promise<GateResult> {
  const commits = Number(await git(worktree, "rev-list", "--count", `${base}..HEAD`));
  if (commits === 0) {
    return { passed: false, reason: "The session produced no commit, so there is no work to check." };
  }

  const tests = await runShell(worktree, testCommand);
  if (tests.exitCode !== 0) {
    const tail = tests.output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
    return {
      passed: false,
      reason: `The Site's test command \`${testCommand}\` is red (exit code ${tests.exitCode}).${tail ? `\n\n${fence(tail)}` : ""}`,
    };
  }

  // Checked after the tests, so a file the tests leave behind counts too.
  const dirty = await git(worktree, "status", "--porcelain");
  if (dirty !== "") {
    return {
      passed: false,
      reason: `The worktree has uncommitted changes after the tests, so what was tested would not be what gets merged:\n\n${fence(dirty)}`,
    };
  }

  const current = await git(worktree, "branch", "--show-current");
  if (current !== branch) {
    return {
      passed: false,
      reason: `The worktree is on ${current === "" ? "a detached HEAD" : `\`${current}\``}, not on \`${branch}\`, so the tested work is not on the Ticket's branch.`,
    };
  }

  return { passed: true, head: await git(worktree, "rev-parse", "HEAD") };
}

function runShell(cwd: string, command: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ exitCode: code ?? (signal ? 128 : 1), output }));
  });
}

function fence(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

import { spawn } from "node:child_process";
import { git } from "./git.ts";

export type GateResult = { passed: true } | { passed: false; reason: string };

const OUTPUT_TAIL_LINES = 30;

/**
 * The gate the script decides, not the model: the session committed something,
 * left nothing uncommitted, and the Site's test command is green.
 */
export async function runGate(worktree: string, base: string, testCommand: string): Promise<GateResult> {
  const commits = Number(await git(worktree, "rev-list", "--count", `${base}..HEAD`));
  if (commits === 0) {
    return { passed: false, reason: "The session produced no commit, so there is no work to check." };
  }

  const dirty = await git(worktree, "status", "--porcelain");
  if (dirty !== "") {
    return {
      passed: false,
      reason: `The session left uncommitted changes, so what was tested would not be what gets merged:\n\n${fence(dirty)}`,
    };
  }

  const tests = await runShell(worktree, testCommand);
  if (tests.exitCode !== 0) {
    const tail = tests.output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
    return {
      passed: false,
      reason: `The Site's test command \`${testCommand}\` is red (exit code ${tests.exitCode}).${tail ? `\n\n${fence(tail)}` : ""}`,
    };
  }

  return { passed: true };
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

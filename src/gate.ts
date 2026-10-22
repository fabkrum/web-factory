import { git, gitSucceeds } from "./git.ts";
import { runShell } from "./shell.ts";

/** A green gate names the commit it tested, so that exact commit is what gets merged. */
export type GateResult = { passed: true; head: string } | { passed: false; reason: string };

const OUTPUT_TAIL_LINES = 30;

/**
 * The gate the script decides, not the model: the session committed something
 * of its own on the Ticket's branch (a merge that only catches up with the
 * integration branch is not work), on top of the integration branch, the Site's test
 * command is green, and after the tests nothing is left uncommitted.
 */
export async function runGate(
  worktree: string,
  base: string,
  branch: string,
  integration: string,
  testCommand: string,
): Promise<GateResult> {
  const commits = Number(await git(worktree, "rev-list", "--count", "--no-merges", `${base}..HEAD`));
  if (commits === 0) {
    return { passed: false, reason: "The session produced no commit, so there is no work to check." };
  }
  if (!(await gitSucceeds(worktree, "merge-base", "--is-ancestor", base, "HEAD"))) {
    return {
      passed: false,
      reason: `The work does not build on \`${integration}\`, so it cannot be fast-forwarded into it.`,
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

function fence(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

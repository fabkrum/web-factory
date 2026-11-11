import { git, gitSucceeds } from "./git.ts";
import { movedPins } from "./pins.ts";
import { runShell } from "./shell.ts";
import { weakenedTests } from "./weakened-tests.ts";

/**
 * A green gate names the commit it tested, so that exact commit is what gets merged,
 * and says what the red run said when the tests were only green on the rerun.
 */
export type GateResult = { passed: true; head: string; flaky?: string } | { passed: false; reason: string };

const OUTPUT_TAIL_LINES = 30;

/**
 * The gate the script decides, not the model: the session committed something
 * of its own on the Ticket's branch (a merge that only catches up with the
 * integration branch is not work), on top of the integration branch, moving no pinned
 * version, deleting, skipping or rewiring none of the Site's tests, the Site's test command is green (a red run gets one rerun), and after the tests
 * nothing is left uncommitted.
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

  const moved = await movedPins(worktree, base, "HEAD");
  if (moved.length > 0) {
    return {
      passed: false,
      reason: `This work changes ${moved.join(" and ")}. Pinned versions move only through the pull request of \`factory update\`, so put them back.`,
    };
  }

  // A green run proves only what the tests still check, so a Ticket keeps every test the Site had.
  const weakened = await weakenedTests(worktree, base, "HEAD");
  if (weakened.length > 0) {
    return {
      passed: false,
      reason: `This work ${weakened.join(", and ")}. A Ticket passes on the tests the Site already had, so put them back and make the work pass them; if a test is really wrong, say so and park the Ticket instead.`,
    };
  }

  const tests = await runTests(worktree, testCommand);
  if (!tests.green) return { passed: false, reason: tests.reason };

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

  const head = await git(worktree, "rev-parse", "HEAD");
  return tests.flaky === undefined ? { passed: true, head } : { passed: true, head, flaky: tests.flaky };
}

type TestRun = { green: true; flaky?: string } | { green: false; reason: string };

/**
 * Runs the Site's test command, and once more when it is red: green on the rerun
 * is flaky, not a failure, and the result keeps what the red run said.
 */
async function runTests(cwd: string, testCommand: string): Promise<TestRun> {
  const first = await runShell(cwd, testCommand);
  if (first.exitCode === 0) return { green: true };
  const red = `The Site's test command \`${testCommand}\` is red (exit code ${first.exitCode}).${tailOf(first.output)}`;
  const again = await runShell(cwd, testCommand);
  if (again.exitCode === 0) return { green: true, flaky: red };
  return {
    green: false,
    reason: `The Site's test command \`${testCommand}\` is red, and red again on the rerun (exit code ${again.exitCode}).${tailOf(again.output)}`,
  };
}

function tailOf(output: string): string {
  const tail = output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  return tail ? `\n\n${fence(tail)}` : "";
}

function fence(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

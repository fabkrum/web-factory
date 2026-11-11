import { CONFIG_FILE } from "./config.ts";
import { git } from "./git.ts";

/**
 * A green test command proves only what the tests still check. A session that cannot make a
 * test pass can delete it, skip it, focus the run on other tests, or change the command that
 * runs them, and the gate would see green. These are the ways this module catches, between
 * two commits; adding tests, moving them where they still run and new scripts are all fine.
 */

/** Where test files live by convention, for the stacks a Site uses (JavaScript, TypeScript, Python). */
const TEST_FILE = [
  /(^|\/)(tests?|__tests__|e2e|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
];

/** An added line that skips a test, marks it unfinished, or narrows the run to some tests. */
const SKIPS = [
  /\b(it|test|describe|suite|context|bench)\.(skip|todo|only|skipIf|fixme)\b/,
  /\b(xit|xtest|xdescribe|xcontext|xspecify|fit|fdescribe)\s*\(/,
  /\{[^}]*\b(skip|todo|only)\s*:\s*(true|["'`])/,
  /\bt\.(skip|todo)\s*\(/,
  /@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.(skip|expectedFailure)/,
];

/** The package.json scripts that run the tests: `test`, its hooks, and every script whose name starts with `test`. */
const TEST_SCRIPT = /^(pre|post)?test(:|$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.some((pattern) => pattern.test(path));
}

/** Why the change from `from` to `to` weakens the Site's tests, one reason each; empty when it does not. */
export async function weakenedTests(cwd: string, from: string, to: string): Promise<string[]> {
  const reasons: string[] = [];

  for (const line of (await git(cwd, "diff", "--name-status", "--find-renames", from, to)).split("\n")) {
    const [status = "", path = "", renamed] = line.split("\t");
    if (status === "D" && isTestFile(path)) reasons.push(`deletes the test file \`${path}\``);
    if (status.startsWith("R") && isTestFile(path) && renamed !== undefined && !isTestFile(renamed)) {
      reasons.push(`deletes the test file \`${path}\` (it moved to \`${renamed}\`, where no test runner looks)`);
    }
  }

  for (const { path, line } of await addedLines(cwd, from, to)) {
    if (isTestFile(path) && SKIPS.some((pattern) => pattern.test(line))) {
      reasons.push(`skips or narrows the Site's tests in \`${path}\`: \`${line.trim()}\``);
    }
  }

  const before = testScripts(await fileAt(cwd, from, "package.json"));
  const after = testScripts(await fileAt(cwd, to, "package.json"));
  for (const [name, command] of before) {
    if (after.get(name) !== command) reasons.push(`changes the Site's test script \`${name}\` in package.json`);
  }

  if (testCommand(await fileAt(cwd, from, CONFIG_FILE)) !== testCommand(await fileAt(cwd, to, CONFIG_FILE))) {
    reasons.push(`changes the Site's test command in ${CONFIG_FILE}`);
  }
  return reasons;
}

async function addedLines(cwd: string, from: string, to: string): Promise<{ path: string; line: string }[]> {
  const diff = await git(cwd, "diff", "--unified=0", "--no-color", "--no-ext-diff", from, to);
  const added: { path: string; line: string }[] = [];
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+")) added.push({ path, line: line.slice(1) });
  }
  return added;
}

async function fileAt(cwd: string, commit: string, path: string): Promise<string | undefined> {
  return git(cwd, "show", `${commit}:${path}`).catch(() => undefined);
}

function testScripts(manifest: string | undefined): Map<string, string> {
  try {
    const { scripts = {} } = JSON.parse(manifest ?? "") as { scripts?: Record<string, string> };
    return new Map(Object.entries(scripts).filter(([name]) => TEST_SCRIPT.test(name)));
  } catch {
    return new Map();
  }
}

function testCommand(config: string | undefined): string | undefined {
  try {
    return (JSON.parse(config ?? "") as { testCommand?: string }).testCommand;
  } catch {
    return undefined;
  }
}

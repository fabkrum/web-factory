/**
 * A stand-in for the `claude` command, run as `node fake-claude.ts <claude's flags>`.
 *
 * Its "model" understands two sentences: "Run: `<command>`" runs the command, and
 * "Ask the Builder: <question>" leaves the question where the system prompt says to.
 * It reads them from the prompt (stdin), from the skills the prompt names ("Use the skill
 * <name>"), and from the Site's instructions (CLAUDE.md, or the appended system prompt),
 * the instructions last. Like Claude Code, it honours the `--settings` it is given: deny
 * rules refuse a command, and with the sandbox on a command may write only inside its
 * directory and the paths the sandbox allows.
 *
 * FAKE_CLAUDE_ERROR makes it end in an error result with that text; FAKE_CLAUDE_STDOUT
 * makes it print exactly that and exit with FAKE_CLAUDE_EXIT (0 by default).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

interface Settings {
  sandbox?: { enabled?: boolean; filesystem?: { allowWrite?: string[] } };
  permissions?: { deny?: string[] };
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const settings = JSON.parse(flag("--settings") ?? "{}") as Settings;
const appended = flag("--append-system-prompt") ?? "";
const cwd = process.cwd();
const prompt = readFileSync(0, "utf8");

if (process.env.FAKE_CLAUDE_STDOUT !== undefined) {
  process.stdout.write(process.env.FAKE_CLAUDE_STDOUT);
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
}
if (process.env.FAKE_CLAUDE_ERROR !== undefined) finish(process.env.FAKE_CLAUDE_ERROR, true);

const said: string[] = [];
const ask = /Ask the Builder: (.+)/.exec(prompt);
if (ask) {
  const file = /write that question in plain words to `([^`]+)`/.exec(appended)?.[1];
  if (!file) finish("I was not told where to leave a question.", true);
  writeFileSync(join(cwd, file), `${ask[1]}\n`);
  finish("I left my question for the Builder.");
}

const instructions = existsSync(join(cwd, "CLAUDE.md")) ? readFileSync(join(cwd, "CLAUDE.md"), "utf8") : appended;
const skills = [...prompt.matchAll(/Use the skill (\w[\w-]*)/g)].map((match) => {
  const path = join(cwd, ".claude", "skills", match[1]!, "SKILL.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
});
for (const text of [prompt, ...skills, instructions]) {
  for (const [, command] of text.matchAll(/run: `([^`]+)`/gi)) run(command!);
}
finish(said.join("\n") || "Done.");

function run(command: string): void {
  const refused = refusal(command);
  if (refused) {
    said.push(`Refused: ${command} (${refused})`);
    return;
  }
  try {
    execSync(command, { cwd, stdio: ["ignore", "ignore", "inherit"] });
    said.push(`Ran: ${command}`);
  } catch {
    said.push(`Failed: ${command}`);
  }
}

function refusal(command: string): string | undefined {
  for (const segment of command.split(/&&|;|\|\|/).map((part) => part.trim())) {
    for (const rule of settings.permissions?.deny ?? []) {
      const prefix = /^Bash\((.+):\*\)$/.exec(rule)?.[1];
      if (prefix && segment.startsWith(prefix)) return `denied by ${rule}`;
    }
    if (!settings.sandbox?.enabled) continue;
    const writable = [cwd, ...(settings.sandbox.filesystem?.allowWrite ?? [])].map(real);
    const targets = [...segment.matchAll(/>\s*(\S+)/g)].map((match) => resolve(cwd, match[1]!));
    if (/^git (add|commit)\b/.test(segment)) {
      targets.push(resolve(cwd, execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf8" }).trim()));
    }
    for (const target of targets) {
      const path = real(target);
      if (!writable.some((dir) => path === dir || isInside(path, dir))) return `the sandbox does not allow writing ${target}`;
    }
  }
  return undefined;
}

function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : join(real(dirname(path)), relative(dirname(path), path));
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function finish(result: string, isError = false): never {
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError, result })}\n`);
  process.exit(isError ? 1 : 0);
}

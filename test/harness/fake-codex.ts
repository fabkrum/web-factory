/**
 * A stand-in for the `codex` command, run as `node fake-codex.ts exec <codex's flags> -`.
 *
 * Its "model" understands the same two sentences as the fake claude: "Run: `<command>`"
 * runs the command, and "Ask the Builder: <question>" leaves the question where the prompt
 * says to. It reads them from the prompt (stdin), from the skills the prompt names ("Use
 * the skill <name>", found in `.agents/skills`), and from the Site's AGENTS.md, the
 * instructions last. Like Codex, it honours `--sandbox`: in workspace-write a command may
 * write only inside its directory and the `--add-dir` directories, and reaches the network
 * only with `sandbox_workspace_write.network_access=true`; in danger-full-access anything goes.
 *
 * FAKE_CODEX_ARGS_FILE records the arguments it was given there, as JSON.
 * FAKE_CODEX_ERROR makes the turn fail with that text; FAKE_CODEX_STDOUT makes it print
 * exactly that and exit with FAKE_CODEX_EXIT (0 by default).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const values = (name: string) => args.flatMap((arg, at) => (arg === name && at + 1 < args.length ? [args[at + 1]!] : []));
const sandbox = values("--sandbox").at(-1) ?? "read-only";
const addDirs = values("--add-dir");
const network = values("-c").includes("sandbox_workspace_write.network_access=true");
const cwd = process.cwd();
const prompt = readFileSync(0, "utf8");
if (process.env.FAKE_CODEX_ARGS_FILE) writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(args));

if (process.env.FAKE_CODEX_STDOUT !== undefined) {
  process.stdout.write(process.env.FAKE_CODEX_STDOUT);
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
}

emit({ type: "thread.started", thread_id: "fake-thread" });
emit({ type: "turn.started" });

if (process.env.FAKE_CODEX_ERROR !== undefined) fail(process.env.FAKE_CODEX_ERROR);
if (args[0] !== "exec" || args.at(-1) !== "-") fail(`The fake codex expects \`exec … -\`, got: ${args.join(" ")}`);

const said: string[] = [];
const ask = /Ask the Builder: (.+)/.exec(prompt);
if (ask) {
  const file = /write that question in plain words to `([^`]+)`/.exec(prompt)?.[1];
  if (!file) fail("I was not told where to leave a question.");
  writeFileSync(join(cwd, file), `${ask[1]}\n`);
  finish("I left my question for the Builder.");
}

const instructions = existsSync(join(cwd, "AGENTS.md")) ? readFileSync(join(cwd, "AGENTS.md"), "utf8") : "";
const skills = [...prompt.matchAll(/Use the skill (\w[\w-]*)/g)].map((match) => {
  const path = join(cwd, ".agents", "skills", match[1]!, "SKILL.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
});
for (const text of [prompt, ...skills, instructions]) {
  for (const [, command] of text.matchAll(/run: `([^`]+)`/gi)) run(command!);
}
finish(said.join("\n") || "Done.");

function run(command: string): void {
  emit({ type: "item.started", item: { type: "command_execution", command, status: "in_progress" } });
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
  if (sandbox === "danger-full-access") return undefined;
  const writable = sandbox === "workspace-write" ? [cwd, ...addDirs].map(real) : [];
  for (const segment of command.split(/&&|;|\|\|/).map((part) => part.trim())) {
    const targets = [...segment.matchAll(/>\s*(\S+)/g)].map((match) => resolve(cwd, match[1]!));
    if (/^git (add|commit)\b/.test(segment)) {
      targets.push(resolve(cwd, execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf8" }).trim()));
    }
    const push = /^git push\b(.*)/.exec(segment);
    if (push) {
      const remote = push[1]!.trim().split(/\s+/).find((word) => word !== "" && !word.startsWith("-")) ?? "origin";
      const url = execFileSync("git", ["remote", "get-url", remote], { cwd, encoding: "utf8" }).trim();
      if (/^[a-z][a-z+.-]*:\/\/|^[^/]+@[^/]+:/i.test(url) && !url.startsWith("file://")) {
        if (!network) return "the sandbox has no network";
      } else {
        targets.push(resolve(cwd, url.replace(/^file:\/\//, "")));
      }
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

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function finish(text: string): never {
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  process.exit(0);
}

function fail(message: string): never {
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

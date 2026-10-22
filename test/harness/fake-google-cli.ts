/**
 * A stand-in for the `agy` and `gemini` commands, run as
 * `node fake-google-cli.ts <antigravity|gemini> <the CLI's flags>`.
 *
 * Its "model" understands the same two sentences as the fake claude: "Run: `<command>`"
 * runs the command, and "Ask the Builder: <question>" leaves the question where the prompt
 * says to. It reads them from the prompt (`-p`), from the skills the prompt names ("Use
 * the skill <name>", found in `.agents/skills`), and from the Site's instructions, last.
 * Like the real CLIs it differs where they do:
 * - Antigravity reads AGENTS.md and GEMINI.md. Gemini reads GEMINI.md unless the settings
 *   file in GEMINI_CLI_SYSTEM_SETTINGS_PATH names other `context.fileName`s, and refuses
 *   the commands its `tools.exclude` lists as `run_shell_command(<prefix>)`.
 * - Antigravity stops at its `--print-timeout` (5 minutes unless given, or
 *   FAKE_AGY_DEFAULT_PRINT_TIMEOUT_MS) and then reports what it has as a success, with a
 *   warning on stderr, as Antigravity CLI does.
 * With `--sandbox` a command may write only inside its directory and the `--add-dir`
 * (Antigravity) or `--include-directories` (Gemini) directories; without it anything goes.
 *
 * FAKE_GOOGLE_ARGS_FILE records the arguments it was given there, as JSON.
 * FAKE_GOOGLE_ERROR makes the run fail with that text, reported the way each CLI reports it;
 * FAKE_GOOGLE_STDOUT makes it print exactly that and exit with FAKE_GOOGLE_EXIT (0 by default).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const [cli, ...args] = process.argv.slice(2);
const values = (name: string) => args.flatMap((arg, at) => (arg === name && at + 1 < args.length ? [args[at + 1]!] : []));
const antigravity = cli === "antigravity";
const sandbox = args.includes("--sandbox");
const addDirs = values(antigravity ? "--add-dir" : "--include-directories");
const prompt = values("-p").at(-1) ?? "";
const cwd = process.cwd();
const started = Date.now();
if (process.env.FAKE_GOOGLE_ARGS_FILE) writeFileSync(process.env.FAKE_GOOGLE_ARGS_FILE, JSON.stringify(args));

if (process.env.FAKE_GOOGLE_STDOUT !== undefined) {
  process.stdout.write(process.env.FAKE_GOOGLE_STDOUT);
  process.exit(Number(process.env.FAKE_GOOGLE_EXIT ?? 0));
}
if (process.env.FAKE_GOOGLE_ERROR !== undefined) fail(process.env.FAKE_GOOGLE_ERROR);
if (cli !== "antigravity" && cli !== "gemini") fail(`The fake Google CLI expects antigravity or gemini first, got: ${cli}`);
if (!prompt || values("--output-format").at(-1) !== "json") fail(`The fake Google CLI expects \`-p <prompt> --output-format json\`, got: ${args.join(" ")}`);

const settings = (() => {
  const path = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (antigravity || !path) return {};
  return JSON.parse(readFileSync(path, "utf8")) as { context?: { fileName?: string | string[] }; tools?: { exclude?: string[] } };
})();
const contextFiles = antigravity ? ["AGENTS.md", "GEMINI.md"] : [settings.context?.fileName ?? "GEMINI.md"].flat();
const excluded = (settings.tools?.exclude ?? []).flatMap((tool) => /^run_shell_command\((.+)\)$/.exec(tool)?.[1] ?? []);
const printTimeoutMs = antigravity ? printTimeout() : Infinity;

const ask = /Ask the Builder: (.+)/.exec(prompt);
if (ask) {
  const file = /write that question in plain words to `([^`]+)`/.exec(prompt)?.[1];
  if (!file) fail("I was not told where to leave a question.");
  writeFileSync(join(cwd, file), `${ask[1]}\n`);
  finish("I left my question for the Builder.");
}

const said: string[] = [];
const instructions = contextFiles.map((file) => (existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : ""));
const skills = [...prompt.matchAll(/Use the skill (\w[\w-]*)/g)].map((match) => {
  const path = join(cwd, ".agents", "skills", match[1]!, "SKILL.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
});
for (const text of [prompt, ...skills, ...instructions]) {
  for (const [, command] of text.matchAll(/run: `([^`]+)`/gi)) run(command!);
}
finish(said.join("\n") || "Done.");

function run(command: string): void {
  const refused = refusal(command);
  if (refused) {
    said.push(`Refused: ${command} (${refused})`);
    return;
  }
  const left = printTimeoutMs - (Date.now() - started);
  try {
    execSync(command, { cwd, stdio: ["ignore", "ignore", "inherit"], timeout: Number.isFinite(left) ? Math.max(left, 1) : undefined });
    said.push(`Ran: ${command}`);
  } catch (error) {
    if ((error as { signal?: string }).signal) {
      // Antigravity CLI past its print timeout: what it has so far, reported as a success.
      process.stderr.write("warning: the print timeout expired before the agent finished; returning the partial response\n");
      finish(said.join("\n") || "(no response yet)");
    }
    said.push(`Failed: ${command}`);
  }
}

function printTimeout(): number {
  const given = values("--print-timeout").at(-1);
  if (given === undefined) return Number(process.env.FAKE_AGY_DEFAULT_PRINT_TIMEOUT_MS ?? 5 * 60_000);
  const match = /^(\d+)(ms|s|m|h)$/.exec(given);
  if (!match) fail(`invalid value for --print-timeout: ${given}`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
}

function refusal(command: string): string | undefined {
  for (const segment of command.split(/&&|;|\|\|/).map((part) => part.trim())) {
    const denied = excluded.find((prefix) => segment === prefix || segment.startsWith(`${prefix} `));
    if (denied) return `${denied} is excluded`;
  }
  if (!sandbox) return undefined;
  const writable = [cwd, ...addDirs].map(real);
  for (const segment of command.split(/&&|;|\|\|/).map((part) => part.trim())) {
    const targets = [...segment.matchAll(/>\s*(\S+)/g)].map((match) => resolve(cwd, match[1]!));
    if (/^git (add|commit)\b/.test(segment)) {
      targets.push(resolve(cwd, execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf8" }).trim()));
    }
    const push = /^git push\b(.*)/.exec(segment);
    if (push) {
      const remote = push[1]!.trim().split(/\s+/).find((word) => word !== "" && !word.startsWith("-")) ?? "origin";
      const url = execFileSync("git", ["remote", "get-url", remote], { cwd, encoding: "utf8" }).trim();
      if (!/^[a-z][a-z+.-]*:\/\/|^[^/]+@[^/]+:/i.test(url) || url.startsWith("file://")) {
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

function finish(response: string): never {
  const result = antigravity
    ? { conversation_id: "fake-conversation", status: "SUCCESS", response, duration_seconds: 1, num_turns: 1, usage: { total_tokens: 2 } }
    : { session_id: "fake-session", response, stats: { models: {} } };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

function fail(message: string): never {
  if (antigravity) {
    process.stdout.write(`${JSON.stringify({ conversation_id: "fake-conversation", status: "ERROR", error: message }, null, 2)}\n`);
    process.stderr.write(`AGY_ERROR: ${JSON.stringify({ message })}\n`);
    process.exit(3);
  }
  process.stderr.write(`${JSON.stringify({ session_id: "fake-session", error: { type: "Error", message, code: 1 } }, null, 2)}\n`);
  process.exit(1);
}

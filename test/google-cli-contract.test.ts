import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GoogleCli, type GoogleCliName } from "../src/google-cli.ts";
import { agentCliContract, type AgentCliSubject } from "./harness/agent-cli-contract.ts";
import { createSiteRepo, writeFile } from "./harness/site-repo.ts";

const FAKE = fileURLToPath(new URL("./harness/fake-google-cli.ts", import.meta.url));
const fake = (cli: GoogleCliName) => [process.execPath, FAKE, cli];
const NAMES: Record<GoogleCliName, { title: string; command: string }> = {
  antigravity: { title: "Antigravity CLI", command: "agy" },
  gemini: { title: "Gemini CLI", command: "gemini" },
};

/** Both read a Site's instructions from AGENTS.md and its skills from `.agents/skills`, the cross-CLI places. */
function googleSubject(agentCli: GoogleCli, rateLimited?: AgentCliSubject["rateLimited"]): AgentCliSubject {
  return {
    agentCli,
    writeInstructions: (dir, text) => writeFile(dir, "AGENTS.md", `# The Site's instructions\n\n${text}\n`),
    writeSkill: (dir, { name, description, body }) =>
      writeFile(dir, `.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`),
    rateLimited,
  };
}

for (const cli of ["antigravity", "gemini"] as const) {
  const { title, command } = NAMES[cli];

  agentCliContract(`the ${title} adapter against a fake ${command}`, async () =>
    googleSubject(new GoogleCli({ cli, command: fake(cli) }), () => {
      const now = new Date(2026, 9, 22, 10, 0);
      return {
        agentCli: new GoogleCli({
          cli,
          command: fake(cli),
          env: { FAKE_GOOGLE_ERROR: "You have exhausted your capacity on this model. Your quota will reset after 2h30m5s." },
          now: () => now,
        }),
        resetsAt: new Date(now.getTime() + (2 * 3600 + 30 * 60 + 5) * 1000),
      };
    }),
  );

  /**
   * The real contract: the adapter against the installed CLI, which costs real usage. CI
   * sets GEMINI_API_KEY from the maintainer's secret; without it, or without the CLI, it
   * is skipped. A Builder's own Google login is never spent by a test run.
   */
  agentCliContract(`the ${title} adapter against the real ${command}`, async () => googleSubject(new GoogleCli({ cli })), {
    skip: realContractSkipReason(title, command),
    timeout: 10 * 60_000,
    sessionTimeoutMs: 5 * 60_000,
  });
}

function realContractSkipReason(title: string, command: string): string | undefined {
  if (!process.env.GEMINI_API_KEY) return "GEMINI_API_KEY is not set; in CI it comes from the CONTRACT_GEMINI_API_KEY secret";
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", timeout: 30_000 });
  } catch {
    return `${title} (${command}) is not installed`;
  }
  return undefined;
}

describe("the Google CLI adapter", () => {
  const session = (cwd: string, prompt = "Build it.", timeoutMs = 30_000) => ({ cwd, prompt, sandbox: true, timeoutMs });
  const site = () => createSiteRepo({ testCommand: "true" });
  const flags = async (cli: GoogleCliName, timeoutMs = 30_000) => {
    const record = join(mkdtempSync(join(tmpdir(), "web-factory-google-args-")), "args.json");
    await new GoogleCli({ cli, command: fake(cli), env: { FAKE_GOOGLE_ARGS_FILE: record } }).runSession(session(site(), "Build it.", timeoutMs));
    return JSON.parse(readFileSync(record, "utf8")) as string[];
  };

  it.each([
    ["antigravity", "Antigravity CLI (the agy command) is not installed, so the Ticket loop cannot run a session with it."],
    ["gemini", "Gemini CLI (the gemini command) is not installed, so the Ticket loop cannot run a session with it."],
  ] as const)("says in plain words when %s is not installed", async (cli, reason) => {
    const adapter = new GoogleCli({ cli, command: ["google-cli-that-is-not-installed"] });

    expect(await adapter.runSession(session(site()))).toEqual({ kind: "failed", reason });
  });

  it.each([
    ["antigravity", "Antigravity CLI"],
    ["gemini", "Gemini CLI"],
  ] as const)("reports %s's own error as the reason the session failed", async (cli, title) => {
    const adapter = new GoogleCli({ cli, command: fake(cli), env: { FAKE_GOOGLE_ERROR: "authentication required" } });

    expect(await adapter.runSession(session(site()))).toEqual({ kind: "failed", reason: `${title} stopped with an error: authentication required` });
  });

  it("fails a session whose output is not the CLI's JSON", async () => {
    const adapter = new GoogleCli({ cli: "gemini", command: fake("gemini"), env: { FAKE_GOOGLE_STDOUT: "Loaded cached credentials.\nHello!\n" } });

    expect(await adapter.runSession(session(site()))).toEqual({ kind: "failed", reason: "Gemini CLI's output was not the JSON it promises." });
  });

  it("fails an Antigravity session that ended without succeeding", async () => {
    const adapter = new GoogleCli({
      cli: "antigravity",
      command: fake("antigravity"),
      env: { FAKE_GOOGLE_STDOUT: '{"conversation_id":"c","status":"CANCELED","response":""}\n' },
    });

    expect(await adapter.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Antigravity CLI stopped with an error: the session ended CANCELED",
    });
  });

  it("does not let Antigravity CLI's own print timeout cut a long session short", async () => {
    const worktree = site();
    const adapter = new GoogleCli({ cli: "antigravity", command: fake("antigravity"), env: { FAKE_AGY_DEFAULT_PRINT_TIMEOUT_MS: "500" } });

    const result = await adapter.runSession(session(worktree, "Run: `sleep 2 && echo finished > finished.txt`"));

    expect(result).toEqual({ kind: "done" });
    expect(existsSync(join(worktree, "finished.txt"))).toBe(true);
  });

  it("gives Antigravity CLI a print timeout longer than the session's own time limit", async () => {
    const args = await flags("antigravity", 90 * 60_000);

    expect(args[args.indexOf("--print-timeout") + 1]).toBe(`${90 * 60 + 60}s`);
  });

  it("makes Gemini CLI read the Site's AGENTS.md, which it would otherwise ignore", async () => {
    const worktree = site();
    writeFile(worktree, "AGENTS.md", "At the end of every session, run: `echo yes > instructions-read.txt`\n");
    const adapter = new GoogleCli({ cli: "gemini", command: fake("gemini") });

    expect(await adapter.runSession(session(worktree))).toEqual({ kind: "done" });
    expect(readFileSync(join(worktree, "instructions-read.txt"), "utf8").trim()).toBe("yes");
  });

  it("keeps a Gemini session from pushing even with the sandbox off", async () => {
    const worktree = site();
    const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: worktree, encoding: "utf8" }).trim();
    const main = execFileSync("git", ["rev-parse", "main"], { cwd: origin, encoding: "utf8" }).trim();
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "Try to publish"], { cwd: worktree });
    const adapter = new GoogleCli({ cli: "gemini", command: fake("gemini") });

    await adapter.runSession({ ...session(worktree, "Run: `git push --force origin HEAD:main`"), sandbox: false });

    expect(execFileSync("git", ["rev-parse", "main"], { cwd: origin, encoding: "utf8" }).trim()).toBe(main);
  });

  const now = new Date(2026, 9, 22, 10, 0);
  it.each([
    ["a per-minute limit in seconds", "You exceeded your current quota, please check your plan and billing details.\nPlease retry in 40.025771073s.", new Date(now.getTime() + 40_026)],
    ["a per-minute limit in milliseconds", "429 Too Many Requests. Please retry in 900.2ms.", new Date(now.getTime() + 901)],
    ["hours, minutes and seconds", "You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.", new Date(now.getTime() + (19 * 3600 + 14 * 60 + 47) * 1000)],
    ["no time at all", "RESOURCE_EXHAUSTED: rate limit exceeded", new Date(now.getTime() + 15 * 60_000)],
  ])("reads when the limit lifts from %s", async (_, error, until) => {
    for (const cli of ["antigravity", "gemini"] as const) {
      const adapter = new GoogleCli({ cli, command: fake(cli), env: { FAKE_GOOGLE_ERROR: error }, now: () => now });

      expect(await adapter.runSession(session(site()))).toEqual({ kind: "rate-limited", until });
    }
  });

  it("treats an empty credit balance as a failure, since waiting does not lift it", async () => {
    const adapter = new GoogleCli({ cli: "antigravity", command: fake("antigravity"), env: { FAKE_GOOGLE_ERROR: "Your AI credits balance is too low to continue." } });

    expect(await adapter.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Antigravity CLI stopped with an error: Your AI credits balance is too low to continue.",
    });
  });
});

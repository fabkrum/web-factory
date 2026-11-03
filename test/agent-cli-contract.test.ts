import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCode } from "../src/claude-code.ts";
import { agentCliContract, type AgentCliSubject } from "./harness/agent-cli-contract.ts";
import { createSiteRepo, writeFile } from "./harness/site-repo.ts";

const FAKE_CLAUDE = [process.execPath, fileURLToPath(new URL("./harness/fake-claude.ts", import.meta.url))];

/** Claude Code reads a Site's instructions from AGENTS.md (through the adapter) and its skills from `.claude/skills`. */
function claudeSubject(agentCli: ClaudeCode, rateLimited?: AgentCliSubject["rateLimited"]): AgentCliSubject {
  return {
    agentCli,
    writeInstructions: (dir, text) => writeFile(dir, "AGENTS.md", `# The Site's instructions\n\n${text}\n`),
    writeSkill: (dir, { name, description, body }) =>
      writeFile(dir, `.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`),
    rateLimited,
  };
}

agentCliContract("the Claude Code adapter against a fake claude", async () =>
  claudeSubject(new ClaudeCode({ command: FAKE_CLAUDE }), () => {
    const now = new Date("2026-10-22T10:00:00Z");
    return {
      agentCli: new ClaudeCode({
        command: FAKE_CLAUDE,
        env: { FAKE_CLAUDE_ERROR: "You've hit your limit · resets 3pm (Europe/Berlin)" },
        now: () => now,
      }),
      resetsAt: new Date("2026-10-22T13:00:00Z"),
    };
  }),
);

/**
 * The real contract: the Claude Code adapter against the installed `claude`, which costs
 * real usage. CI sets ANTHROPIC_API_KEY from the maintainer's secret; without a key or a
 * CLAUDE_CODE_OAUTH_TOKEN, or without the CLI, it is skipped.
 */
agentCliContract("the Claude Code adapter against the real claude", async () => claudeSubject(new ClaudeCode()), {
  skip: realContractSkipReason(),
  timeout: 10 * 60_000,
  sessionTimeoutMs: 5 * 60_000,
});

function realContractSkipReason(): string | undefined {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return "neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set; in CI the key comes from the CONTRACT_ANTHROPIC_API_KEY secret";
  }
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    return "Claude Code (claude) is not installed";
  }
  return undefined;
}

describe("the Claude Code adapter", () => {
  const session = (cwd: string) => ({ cwd, prompt: "Build it.", sandbox: true, timeoutMs: 30_000 });
  const site = () => createSiteRepo({ testCommand: "true" });

  it("says in plain words when Claude Code is not installed", async () => {
    const claude = new ClaudeCode({ command: ["claude-that-is-not-installed"] });

    expect(await claude.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Claude Code (the claude command) is not installed, so the Ticket loop cannot run a session with it.",
    });
  });

  it("reports Claude Code's own error as the reason the session failed", async () => {
    const claude = new ClaudeCode({ command: FAKE_CLAUDE, env: { FAKE_CLAUDE_ERROR: "Credit balance is too low" } });

    expect(await claude.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Claude Code stopped with an error: Credit balance is too low",
    });
  });

  it("stops the session instead of running it unconfined on a machine without a sandbox backend", async () => {
    const worktree = site();
    const claude = new ClaudeCode({ command: FAKE_CLAUDE, env: { FAKE_CLAUDE_NO_SANDBOX: "1" } });

    const result = await claude.runSession({ ...session(worktree), prompt: "Run: `echo built > built.txt`" });

    expect(result).toEqual({ kind: "failed", reason: "Claude Code stopped with an error: sandbox is enabled but dependencies are missing" });
    expect(existsSync(join(worktree, "built.txt"))).toBe(false);
  });

  it("fails a session whose output is not Claude Code's JSON", async () => {
    const claude = new ClaudeCode({ command: FAKE_CLAUDE, env: { FAKE_CLAUDE_STDOUT: "Welcome to Claude Code!\n" } });

    expect(await claude.runSession(session(site()))).toEqual({ kind: "failed", reason: "Claude Code's output was not the JSON it promises." });
  });

  it.each([
    ["an epoch after a bar", "Claude AI usage limit reached|1792677600", "2026-10-22T10:00:00Z", "2026-10-22T14:00:00Z"],
    ["a clock time later today", "5-hour limit reached ∙ resets 3pm (Europe/Berlin)", "2026-10-22T10:00:00Z", "2026-10-22T13:00:00Z"],
    ["a clock time already past today", "You've hit your limit · resets 9am (Europe/Berlin)", "2026-10-22T10:00:00Z", "2026-10-23T07:00:00Z"],
    ["a date and a clock time", "Weekly limit reached ∙ resets Oct 27, 4:30pm (Europe/Berlin)", "2026-10-22T10:00:00Z", "2026-10-27T15:30:00Z"],
    ["no time at all", "API Error: 429 rate_limit_error", "2026-10-22T10:00:00Z", "2026-10-22T10:15:00Z"],
  ])("reads when the limit lifts from %s", async (_, error, now, until) => {
    const claude = new ClaudeCode({ command: FAKE_CLAUDE, env: { FAKE_CLAUDE_ERROR: error }, now: () => new Date(now) });

    expect(await claude.runSession(session(site()))).toEqual({ kind: "rate-limited", until: new Date(until) });
  });

});

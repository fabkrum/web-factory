import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Codex } from "../src/codex.ts";
import { agentCliContract, type AgentCliSubject } from "./harness/agent-cli-contract.ts";
import { createSiteRepo, writeFile } from "./harness/site-repo.ts";

const FAKE_CODEX = [process.execPath, fileURLToPath(new URL("./harness/fake-codex.ts", import.meta.url))];

/** Codex reads a Site's instructions from AGENTS.md and its skills from `.agents/skills`, both by itself. */
function codexSubject(agentCli: Codex, rateLimited?: AgentCliSubject["rateLimited"]): AgentCliSubject {
  return {
    agentCli,
    writeInstructions: (dir, text) => writeFile(dir, "AGENTS.md", `# The Site's instructions\n\n${text}\n`),
    writeSkill: (dir, { name, description, body }) =>
      writeFile(dir, `.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`),
    rateLimited,
  };
}

agentCliContract("the Codex adapter against a fake codex", async () =>
  codexSubject(new Codex({ command: FAKE_CODEX }), () => {
    const now = new Date(2026, 9, 22, 10, 0);
    return {
      agentCli: new Codex({
        command: FAKE_CODEX,
        env: {
          FAKE_CODEX_ERROR:
            "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:45 PM.",
        },
        now: () => now,
      }),
      resetsAt: new Date(2026, 9, 22, 15, 45),
    };
  }),
);

/**
 * The real contract: the Codex adapter against the installed `codex`, which costs real
 * usage. CI sets CODEX_API_KEY from the maintainer's secret; without it, or without the
 * CLI, it is skipped. A Builder's own ChatGPT login is never spent by a test run.
 */
agentCliContract("the Codex adapter against the real codex", async () => codexSubject(new Codex()), {
  skip: realContractSkipReason(),
  timeout: 10 * 60_000,
  sessionTimeoutMs: 5 * 60_000,
});

function realContractSkipReason(): string | undefined {
  if (!process.env.CODEX_API_KEY) {
    return "CODEX_API_KEY is not set; in CI it comes from the CONTRACT_OPENAI_API_KEY secret";
  }
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
  } catch {
    return "Codex (codex) is not installed";
  }
  return undefined;
}

describe("the Codex adapter", () => {
  const session = (cwd: string) => ({ cwd, prompt: "Build it.", sandbox: true, timeoutMs: 30_000 });
  const site = () => createSiteRepo({ testCommand: "true" });

  it("says in plain words when Codex is not installed", async () => {
    const codex = new Codex({ command: ["codex-that-is-not-installed"] });

    expect(await codex.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Codex (the codex command) is not installed, so the Ticket loop cannot run a session with it.",
    });
  });

  it("reports Codex's own error as the reason the session failed", async () => {
    const codex = new Codex({ command: FAKE_CODEX, env: { FAKE_CODEX_ERROR: "unexpected status 401 Unauthorized" } });

    expect(await codex.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Codex stopped with an error: unexpected status 401 Unauthorized",
    });
  });

  it("fails a session whose output is not Codex's JSON Lines", async () => {
    const codex = new Codex({ command: FAKE_CODEX, env: { FAKE_CODEX_STDOUT: "Welcome to Codex!\n" } });

    expect(await codex.runSession(session(site()))).toEqual({ kind: "failed", reason: "Codex's output was not the JSON Lines it promises." });
  });

  it("fails a session that ends without finishing its turn", async () => {
    const codex = new Codex({ command: FAKE_CODEX, env: { FAKE_CODEX_STDOUT: '{"type":"thread.started"}\n{"type":"turn.started"}\n' } });

    expect(await codex.runSession(session(site()))).toEqual({
      kind: "failed",
      reason: "Codex stopped with an error: codex exited with code 0 and printed nothing",
    });
  });

  const now = new Date(2026, 9, 22, 10, 0);
  it.each([
    ["a clock time later today", "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 3:45 PM.", new Date(2026, 9, 22, 15, 45)],
    ["a clock time already past today", "You've hit your usage limit. Try again at 9:05 AM.", new Date(2026, 9, 23, 9, 5)],
    ["a date and a clock time", "You've hit your usage limit. Upgrade to Pro, or try again at Oct 27th, 2026 4:30 PM.", new Date(2026, 9, 27, 16, 30)],
    ["days, hours and minutes", "You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.", new Date(now.getTime() + ((2 * 24 + 3) * 60 + 5) * 60_000)],
    ["a compact span", "Rate limit reached for gpt-5-codex. Please try again in 6m0s.", new Date(now.getTime() + 6 * 60_000)],
    ["seconds with a fraction", "Rate limit reached for requests. Please try again in 1.5s.", new Date(now.getTime() + 1500)],
    ["less than a minute", "You've hit your usage limit. Try again in less than a minute.", new Date(now.getTime() + 60_000)],
    ["no time at all", "exceeded retry limit, last status: 429 Too Many Requests", new Date(now.getTime() + 15 * 60_000)],
  ])("reads when the limit lifts from %s", async (_, error, until) => {
    const codex = new Codex({ command: FAKE_CODEX, env: { FAKE_CODEX_ERROR: error }, now: () => now });

    expect(await codex.runSession(session(site()))).toEqual({ kind: "rate-limited", until });
  });

  it("keeps a sandboxed session off the network unless the Site needs it", async () => {
    const flags = async (options: { network?: boolean }) => {
      const record = join(mkdtempSync(join(tmpdir(), "web-factory-codex-args-")), "args.json");
      await new Codex({ command: FAKE_CODEX, env: { FAKE_CODEX_ARGS_FILE: record }, ...options }).runSession(session(site()));
      return (JSON.parse(readFileSync(record, "utf8")) as string[]).join(" ");
    };

    expect(await flags({})).toContain("--sandbox workspace-write");
    expect(await flags({})).toContain("-c sandbox_workspace_write.network_access=false");
    expect(await flags({ network: true })).toContain("-c sandbox_workspace_write.network_access=true");
  });
});

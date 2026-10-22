import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, readAgentCliChoice } from "../src/config.ts";
import { writeFile } from "./harness/site-repo.ts";

describe("the Site's choice of Agent CLI", () => {
  const siteWith = (config?: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "web-factory-choice-"));
    if (config !== undefined) writeFile(dir, "factory.json", JSON.stringify(config));
    return dir;
  };

  it("is the one factory.json names", async () => {
    expect(await readAgentCliChoice(siteWith({ testCommand: "true", agentCli: "codex" }))).toBe("codex");
  });

  it("is Claude Code while the Site names none", async () => {
    expect(await readAgentCliChoice(siteWith({ testCommand: "true" }))).toBe("claude-code");
    expect(await readAgentCliChoice(siteWith())).toBe("claude-code");
  });

  it("refuses an Agent CLI the Factory has no adapter for, in plain words", async () => {
    await expect(readAgentCliChoice(siteWith({ testCommand: "true", agentCli: "copilot" }))).rejects.toThrow(
      new ConfigError('factory.json names the Agent CLI "copilot", but the Factory supports only claude-code and codex.'),
    );
  });
});

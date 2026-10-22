import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { createSiteRepo } from "./harness/site-repo.ts";

describe("the factory command", () => {
  it("says how to use it when the command is unknown", async () => {
    const run = await runFactory(["frobnicate"], {
      cwd: process.cwd(),
      agentCli: new FakeAgentCli(),
      tracker: new FakeTracker(),
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/factory loop <spec>/);
  });

  it("refuses a loop without a Spec number", async () => {
    const site = createSiteRepo({ testCommand: "true" });
    const run = await runFactory(["loop"], { cwd: site, agentCli: new FakeAgentCli(), tracker: new FakeTracker() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/Spec/);
  });

  it("explains a Site without its Factory config", async () => {
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A Spec");
    const run = await runFactory(["loop", String(spec)], {
      cwd: mkdtempSync(join(tmpdir(), "web-factory-empty-")),
      agentCli: new FakeAgentCli(),
      tracker,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/factory\.json/);
  });

  it("runs as an installed command", () => {
    const help = execFileSync(process.execPath, ["src/bin.ts", "--help"], { encoding: "utf8" });

    expect(help).toMatch(/factory loop <spec>/);
  });
});

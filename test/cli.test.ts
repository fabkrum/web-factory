import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFactory } from "./harness/run-factory.ts";

describe("the factory command", () => {
  it("says how to use it when the command is unknown", async () => {
    const run = await runFactory(["frobnicate"], { cwd: process.cwd() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/factory review <url>/);
  });

  it("refuses a review without an address", async () => {
    const run = await runFactory(["review"], { cwd: process.cwd() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/http:\/\//);
  });

  it("runs as an installed command", () => {
    const help = execFileSync(process.execPath, ["src/bin.ts", "--help"], { encoding: "utf8" });

    expect(help).toMatch(/factory review <url>/);
  });
});

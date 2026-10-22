import { factory } from "../../src/cli.ts";
import type { AgentCli } from "../../src/agent-cli.ts";
import type { Tracker } from "../../src/tracker.ts";
import { FakeClock } from "./fake-clock.ts";

export interface FactoryRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the real `factory` command in a Site repository, with its boundaries faked. */
export async function runFactory(
  argv: string[],
  options: { cwd: string; agentCli: AgentCli; tracker: Tracker; clock?: FakeClock },
): Promise<FactoryRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await factory(argv, {
    cwd: options.cwd,
    agentCli: options.agentCli,
    tracker: options.tracker,
    // Never the real clock: a test that waits out a rate limit must not sleep.
    clock: options.clock ?? new FakeClock(),
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

import { factory } from "../../src/cli.ts";
import type { AgentCli } from "../../src/agent-cli.ts";
import type { Host } from "../../src/host.ts";
import type { FactoryReleases } from "../../src/releases.ts";
import type { ReviewSite } from "../../src/ticket-loop.ts";
import type { Tracker } from "../../src/tracker.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeHost } from "./fake-host.ts";

/** Every Review check passes, without a browser; tests of a Review pass their own, or the real checks. */
export const everyCheckPasses: ReviewSite = async (url) => ({ url: url.href, routes: ["/"], passed: true, areas: [] });

export interface FactoryRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the real `factory` command in a directory, capturing what it prints, with its boundaries faked. */
export async function runFactory(
  argv: string[],
  options: { cwd: string; agentCli?: AgentCli; tracker?: Tracker; clock?: FakeClock; host?: Host; reviewSite?: ReviewSite; releases?: FactoryReleases },
): Promise<FactoryRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await factory(argv, {
    cwd: options.cwd,
    agentCli: options.agentCli,
    tracker: options.tracker,
    releases: options.releases,
    host: options.host ?? new FakeHost(),
    reviewSite: options.reviewSite ?? everyCheckPasses,
    // Never the real clock: a test that waits out a rate limit must not sleep.
    clock: options.clock ?? new FakeClock(),
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

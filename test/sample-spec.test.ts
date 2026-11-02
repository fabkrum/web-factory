import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CLIS } from "../src/config.ts";
import { FakeAgentCli, requestsChanges } from "./harness/fake-agent-cli.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { everyCheckPasses } from "./harness/run-factory.ts";
import { buildSampleTicket, createSampleSite, describeRun, PatientClock, runNightly, runSampleSpec, SUPPORTED_CLIS } from "./harness/sample-spec.ts";
import { git } from "./harness/site-repo.ts";

const REPOSITORY = resolve(import.meta.dirname, "..");

const runScript = (cli: string, env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ["test/ci/sample-spec.ts", cli], { cwd: REPOSITORY, encoding: "utf8", env });

/** The environment of a CI step: none of the machine's own keys. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const { keys } of Object.values(SUPPORTED_CLIS)) for (const key of keys) delete env[key];
  return { ...env, ...extra };
}

/** A folder with a `command` that answers --version and fails every session, the way a CLI with a dead key does. */
function brokenCli(command: string): string {
  const dir = mkdtempSync(join(tmpdir(), "web-factory-broken-cli-"));
  writeFileSync(join(dir, command), `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "the key was refused" >&2\nexit 1\n`);
  chmodSync(join(dir, command), 0o755);
  return dir;
}

describe("the sample Spec", () => {
  it("starts from a Site with green tests, the template's instructions and its own Stack section", () => {
    const site = createSampleSite();

    expect(execFileSync("sh", ["-c", "node --test tests/*.mjs"], { cwd: site, encoding: "utf8" })).toMatch(/pass 1/);
    const instructions = readFileSync(join(site, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Modern Web Guidance");
    expect(instructions).not.toContain("Not decided yet");
    expect(readFileSync(join(site, ".claude/skills/modern-web-guidance/SKILL.md"), "utf8")).not.toBe("");
    expect(git(site, "status", "--porcelain")).toBe("");
  });

  it("reaches a Pass under the real Review checks when the Ticket is built as it asks", async () => {
    const agentCli = new FakeAgentCli(({ cwd }) => buildSampleTicket(cwd));

    const run = await runSampleSpec({ agentCli });

    expect(run).toEqual({ outcome: "pass", pullRequest: expect.stringContaining("pull"), preview: "https://preview.example.test/spec-1" });
    expect(agentCli.reviewSessions).toHaveLength(1);
  });

  it("reports the reason when the Ticket parks after its attempts", async () => {
    const failed = () => ({ kind: "failed" as const, reason: "the key was refused" });
    const agentCli = new FakeAgentCli(failed, failed, failed);

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses });

    expect(run.outcome).toBe("parked");
    expect(run).toHaveProperty("reason", expect.stringContaining("the key was refused"));
  });

  it("reports the question when a session asks for a decision", async () => {
    const agentCli = new FakeAgentCli(() => ({ kind: "decision", question: "Which days is the bakery open?" }));

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses });

    expect(run.outcome).toBe("parked");
    expect(run).toHaveProperty("reason", expect.stringContaining("Which days is the bakery open?"));
  });

  it("reports the code review's points when it keeps sending the Ticket back", async () => {
    const build = ({ cwd }: { cwd: string }) => buildSampleTicket(cwd);
    const back = requestsChanges([{ text: "The hours are wrong." }]);
    const tryAgain = ({ cwd }: { cwd: string }) => void git(cwd, "commit", "-q", "--allow-empty", "-m", "Try again");
    const agentCli = new FakeAgentCli(build, tryAgain, tryAgain).reviewing(back, back, back);

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses });

    expect(run.outcome).toBe("parked");
    expect(run).toHaveProperty("reason", expect.stringContaining("The hours are wrong."));
  });

  it("waits out a short rate limit and goes on", async () => {
    const clock = new FakeClock();
    const agentCli = new FakeAgentCli(
      () => ({ kind: "rate-limited", until: new Date(clock.now().getTime() + 10 * 60_000) }),
      ({ cwd }) => buildSampleTicket(cwd),
    );

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses, clock: new PatientClock(clock) });

    expect(run.outcome).toBe("pass");
    expect(clock.sleeps).toEqual([10 * 60_000]);
  });

  it("stops with the reason instead of waiting out a long rate limit", async () => {
    const clock = new FakeClock();
    const agentCli = new FakeAgentCli(() => ({ kind: "rate-limited", until: new Date(clock.now().getTime() + 5 * 3_600_000) }));

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses, clock: new PatientClock(clock) });

    expect(run.outcome).toBe("stopped");
    expect(run).toHaveProperty("reason", expect.stringContaining("300 minutes"));
    expect(clock.sleeps).toEqual([]);
  });

  it("stops with the reason when short rate limits keep coming back", async () => {
    const clock = new FakeClock();
    const limited = () => ({ kind: "rate-limited" as const, until: new Date(clock.now().getTime() + 15 * 60_000) });
    const agentCli = new FakeAgentCli(limited, limited, limited);

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses, clock: new PatientClock(clock) });

    expect(run.outcome).toBe("stopped");
    expect(run).toHaveProperty("reason", expect.stringContaining("already waited 30 minutes"));
    expect(clock.sleeps).toEqual([15 * 60_000, 15 * 60_000]);
  });

  it("adds up the waits of the Build session and the code review", async () => {
    const clock = new FakeClock();
    const limited = () => ({ kind: "rate-limited" as const, until: new Date(clock.now().getTime() + 15 * 60_000) });
    const agentCli = new FakeAgentCli(limited, ({ cwd }) => buildSampleTicket(cwd)).reviewing(limited, limited);

    const run = await runSampleSpec({ agentCli, reviewSite: everyCheckPasses, clock: new PatientClock(clock) });

    expect(run.outcome).toBe("stopped");
    expect(clock.sleeps).toEqual([15 * 60_000, 15 * 60_000]);
  });
});

describe("the nightly run of one Agent CLI", () => {
  it.each(AGENT_CLIS)("skips %s with the secret it lacks", async (cli) => {
    const run = await runNightly(cli, cleanEnv());

    expect(run).toEqual({ outcome: "skipped", reason: expect.stringContaining(SUPPORTED_CLIS[cli].secret) });
  });

  it("says when the key is there but the Agent CLI is not", async () => {
    const run = await runNightly("gemini", cleanEnv({ GEMINI_API_KEY: "a-key", PATH: "/nowhere" }));

    expect(run).toEqual({ outcome: "skipped", reason: "Gemini CLI (gemini) is not installed." });
  });

  it("reports each outcome in one line that names the Agent CLI", () => {
    expect(describeRun("codex", { outcome: "pass", pullRequest: "https://pr", preview: "https://preview" })).toBe("Codex: Pass. Pull request https://pr with the Preview https://preview.\n");
    expect(describeRun("antigravity", { outcome: "parked", reason: "Why." })).toBe("Antigravity CLI: Parked. Why.\n");
  });

  it("reports a skip in the job summary and leaves the job green", () => {
    const summary = join(mkdtempSync(join(tmpdir(), "web-factory-summary-")), "summary.md");

    const run = runScript("gemini", cleanEnv({ GITHUB_STEP_SUMMARY: summary }));

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("Gemini CLI: Skipped. GEMINI_API_KEY is not set; in CI it comes from the CONTRACT_GEMINI_PAID_API_KEY secret.\n");
    expect(readFileSync(summary, "utf8")).toBe(run.stdout);
  });

  it("reports why a real adapter parked in the job summary and fails the job", () => {
    const summary = join(mkdtempSync(join(tmpdir(), "web-factory-summary-")), "summary.md");
    const path = `${brokenCli("codex")}:${process.env.PATH}`;

    const run = runScript("codex", cleanEnv({ CODEX_API_KEY: "a-dead-key", PATH: path, GITHUB_STEP_SUMMARY: summary }));

    expect(run.status, run.stderr).toBe(1);
    expect(run.stdout).toContain("Codex: Parked.");
    expect(run.stdout).toContain("the key was refused");
    expect(readFileSync(summary, "utf8")).toBe(run.stdout);
  });

  it("refuses a name that is no Agent CLI", () => {
    const run = runScript("cursor", cleanEnv());

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("claude-code");
  });
});

describe("the nightly workflow", () => {
  const workflows = join(REPOSITORY, ".github", "workflows");
  const nightly = readFileSync(join(workflows, "nightly.yml"), "utf8");
  const triggers = (text: string) => /^on:\n((?:[ ].*\n)+)/m.exec(text)?.[1] ?? "";
  const jobs = Object.fromEntries(
    nightly
      .split(/^ {2}(?=[\w-]+:\n {4}runs-on)/m)
      .slice(1)
      .map((job) => [job.slice(0, job.indexOf(":")), job]),
  );

  it("runs nightly and by hand, never on a pull request or a push", () => {
    expect(triggers(nightly)).toMatch(/schedule:\n\s+- cron:/);
    expect(triggers(nightly)).toContain("workflow_dispatch:");
    expect(triggers(nightly)).not.toMatch(/pull_request|push/);
  });

  it.each(AGENT_CLIS)("has a job for %s that gets its own secret and no other", (cli) => {
    const job = jobs[cli]!;

    expect(job).toContain(`node test/ci/sample-spec.ts ${cli}`);
    expect(job.match(/secrets\.\w+/g)).toEqual([`secrets.${SUPPORTED_CLIS[cli].secret}`]);
    expect(job).toContain("persist-credentials: false");
    expect(job).toMatch(/timeout-minutes: \d+/);
  });

  it("gives no workflow that a pull request starts an Agent CLI's secret", () => {
    const secrets = Object.values(SUPPORTED_CLIS).map(({ secret }) => secret);
    for (const file of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, file), "utf8");
      if (!/pull_request/.test(triggers(text))) continue;
      for (const secret of secrets) expect(text, file).not.toContain(`secrets.${secret}`);
    }
  });
});

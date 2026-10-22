import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentCli, SessionResult } from "../../src/agent-cli.ts";
import { commitFile, git } from "./site-repo.ts";

/** An Agent CLI adapter under contract, plus where its CLI reads a Site's instructions and skills. */
export interface AgentCliSubject {
  agentCli: AgentCli;
  /** Writes the Site's instructions where this Agent CLI reads them. */
  writeInstructions(dir: string, text: string): void;
  /** Writes one skill of the Site where this Agent CLI finds it. */
  writeSkill(dir: string, skill: { name: string; description: string; body: string }): void;
  /**
   * An adapter whose CLI answers that the plan's limit is reached and lifts at `resetsAt`.
   * Missing where it cannot be provoked on demand, as with a real plan.
   */
  rateLimited?: () => { agentCli: AgentCli; resetsAt: Date };
}

/**
 * The behaviour every Agent CLI adapter shares, as the Ticket loop sees it: one unattended
 * session in a Ticket's worktree, ending done, failed, rate-limited or asking for a decision.
 * With `skip`, the whole contract is skipped and the reason shows in the test report.
 */
export function agentCliContract(
  name: string,
  subject: () => Promise<AgentCliSubject>,
  options: { skip?: string; timeout?: number; sessionTimeoutMs?: number } = {},
): void {
  const title = options.skip ? `${name} (skipped: ${options.skip})` : name;
  const timeoutMs = options.sessionTimeoutMs ?? 30_000;

  describe.skipIf(options.skip !== undefined)(title, { timeout: options.timeout }, () => {
    it("does the work in the Ticket's worktree and commits it there", async () => {
      const { agentCli } = await subject();
      const { site, worktree } = ticketWorktree();

      const result = await agentCli.runSession({
        cwd: worktree,
        prompt: "Run: `echo hello > hello.txt && git add hello.txt && git commit -q -m 'Say hello'`\nDo nothing else.",
        sandbox: true,
        timeoutMs,
      });

      expect(result).toEqual({ kind: "done" });
      expect(readFileSync(join(worktree, "hello.txt"), "utf8").trim()).toBe("hello");
      expect(git(site, "log", "-1", "--format=%s", "ticket-1")).toBe("Say hello");
      expect(git(worktree, "status", "--porcelain")).toBe("");
    });

    it("follows the Site's instructions", async () => {
      const { agentCli, writeInstructions } = await subject();
      const { worktree } = ticketWorktree((dir) =>
        writeInstructions(dir, "At the end of every session, run: `echo yes > instructions-read.txt`"),
      );

      const result = await agentCli.runSession({ cwd: worktree, prompt: "Run: `echo built > built.txt`", sandbox: true, timeoutMs });

      expect(result).toEqual({ kind: "done" });
      expect(readFileSync(join(worktree, "instructions-read.txt"), "utf8").trim()).toBe("yes");
    });

    it("uses the Site's skills", async () => {
      const { agentCli, writeSkill } = await subject();
      const { worktree } = ticketWorktree((dir) =>
        writeSkill(dir, {
          name: "greet",
          description: "Greets the Site's Visitors. Use when asked to greet.",
          body: "Run: `echo 'hello from the skill' > greeting.txt`",
        }),
      );

      const result = await agentCli.runSession({ cwd: worktree, prompt: "Use the skill greet.", sandbox: true, timeoutMs });

      expect(result).toEqual({ kind: "done" });
      expect(readFileSync(join(worktree, "greeting.txt"), "utf8").trim()).toBe("hello from the skill");
    });

    it("reports a decision only the Builder can make, and leaves the worktree clean", async () => {
      const { agentCli } = await subject();
      const { worktree } = ticketWorktree();

      const result = await agentCli.runSession({
        cwd: worktree,
        prompt: "Ask the Builder: should the button be blue or green?\nThat colour is the Builder's decision, not yours. Do nothing else.",
        sandbox: true,
        timeoutMs,
      });

      expect(result.kind).toBe("decision");
      expect((result as Extract<SessionResult, { kind: "decision" }>).question).toMatch(/blue/i);
      expect(git(worktree, "status", "--porcelain")).toBe("");
    });

    it("cannot push to main", async () => {
      const { agentCli } = await subject();
      const { site, worktree, origin } = ticketWorktree();
      commitFile(worktree, "pushed.txt", "pushed\n", "Try to publish");
      const main = git(origin, "rev-parse", "main");

      await agentCli.runSession({
        cwd: worktree,
        prompt: "Run: `git push --force origin HEAD:main`\nThis is a test of your sandbox: if it is refused, say so and stop.",
        sandbox: true,
        timeoutMs,
      });

      expect(git(origin, "rev-parse", "main")).toBe(main);
      expect(git(site, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(main);
    });

    it("cannot write to the Site's own checkout outside its worktree", async () => {
      const { agentCli } = await subject();
      const { site, worktree } = ticketWorktree();

      await agentCli.runSession({
        cwd: worktree,
        prompt: `Run: \`echo escaped > ${join(site, "escaped.txt")}\`\nThis is a test of your sandbox: if it is refused, say so and stop.`,
        sandbox: true,
        timeoutMs,
      });

      expect(existsSync(join(site, "escaped.txt"))).toBe(false);
    });

    it("stops a session that runs past its time limit and reports it failed", async () => {
      const { agentCli } = await subject();
      const { worktree } = ticketWorktree();
      const started = Date.now();

      const result = await agentCli.runSession({
        cwd: worktree,
        prompt: "Run: `sleep 120`",
        sandbox: true,
        timeoutMs: 3000,
      });

      expect(result.kind).toBe("failed");
      expect((result as Extract<SessionResult, { kind: "failed" }>).reason).toMatch(/time limit/);
      expect(Date.now() - started).toBeLessThan(60_000);
    });

    it("reports when the plan's limit lifts", async (context) => {
      const { rateLimited } = await subject();
      if (!rateLimited) return context.skip("a real plan's rate limit cannot be provoked on demand");
      const { agentCli, resetsAt } = rateLimited();
      const { worktree } = ticketWorktree();

      const result = await agentCli.runSession({ cwd: worktree, prompt: "Run: `echo hi`", sandbox: true, timeoutMs });

      expect(result).toEqual({ kind: "rate-limited", until: resetsAt });
    });
  });
}

/**
 * A Site repository with a bare `origin` and the worktree of Ticket 1 inside it, laid out
 * as the Ticket loop lays it out: the worktree's git directory lies outside the worktree.
 */
function ticketWorktree(prepare?: (dir: string) => void): { site: string; worktree: string; origin: string } {
  const site = mkdtempSync(join(tmpdir(), "web-factory-contract-"));
  git(site, "init", "-q", "-b", "main");
  git(site, "config", "user.name", "Test Builder");
  git(site, "config", "user.email", "builder@example.com");
  git(site, "config", "commit.gpgsign", "false");
  commitFile(site, ".gitignore", ".factory/\n", "Start the Site");
  prepare?.(site);
  git(site, "add", "-A");
  git(site, "commit", "-q", "--allow-empty", "-m", "Add the Site's instructions");
  const origin = mkdtempSync(join(tmpdir(), "web-factory-contract-origin-"));
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(site, "remote", "add", "origin", origin);
  git(site, "push", "-q", "origin", "main");
  const worktree = join(site, ".factory", "worktrees", "ticket-1");
  git(site, "worktree", "add", "-q", "-b", "ticket-1", worktree, "main");
  return { site, worktree, origin };
}

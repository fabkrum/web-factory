import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCli, Session, SessionResult } from "../../src/agent-cli.ts";
import { CODE_REVIEW_FILE, type CodeReview } from "../../src/code-review.ts";

export type ScriptedSession = (session: Session) => SessionResult | void | Promise<SessionResult | void>;

/** A code review session that leaves this report, as a real session does. */
export const reports =
  (report: unknown): ScriptedSession =>
  ({ cwd }) =>
    writeFileSync(join(cwd, CODE_REVIEW_FILE), JSON.stringify(report));

export const approves = (points: CodeReview["points"] = []): ScriptedSession => reports({ verdict: "approve", points });
export const requestsChanges = (points: CodeReview["points"]): ScriptedSession => reports({ verdict: "changes", points });

/**
 * A scripted Agent CLI: each Build session runs the next step of the script in the
 * session's directory, as a real Agent CLI would edit and commit there. Code review
 * sessions run their own script, set with `reviewing`; past its end they approve.
 */
export class FakeAgentCli implements AgentCli {
  readonly sessions: Session[] = [];
  readonly reviewSessions: Session[] = [];
  readonly #script: ScriptedSession[];
  #reviews: ScriptedSession[] = [];

  constructor(...script: ScriptedSession[]) {
    this.#script = script;
  }

  reviewing(...script: ScriptedSession[]): this {
    this.#reviews = script;
    return this;
  }

  async runSession(session: Session): Promise<SessionResult> {
    if (session.stage === "review") {
      this.reviewSessions.push(session);
      const step = this.#reviews[this.reviewSessions.length - 1] ?? approves();
      return (await step(session)) ?? { kind: "done" };
    }
    this.sessions.push(session);
    const step = this.#script[this.sessions.length - 1];
    if (!step) throw new Error(`fake Agent CLI has no scripted session #${this.sessions.length}`);
    return (await step(session)) ?? { kind: "done" };
  }
}

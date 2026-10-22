import type { AgentCli, Session, SessionResult } from "../../src/agent-cli.ts";

export type ScriptedSession = (session: Session) => SessionResult | void | Promise<SessionResult | void>;

/**
 * A scripted Agent CLI: each session runs the next step of the script in the
 * session's directory, as a real Agent CLI would edit and commit there.
 */
export class FakeAgentCli implements AgentCli {
  readonly sessions: Session[] = [];
  readonly #script: ScriptedSession[];

  constructor(...script: ScriptedSession[]) {
    this.#script = script;
  }

  async runSession(session: Session): Promise<SessionResult> {
    this.sessions.push(session);
    const step = this.#script[this.sessions.length - 1];
    if (!step) throw new Error(`fake Agent CLI has no scripted session #${this.sessions.length}`);
    return (await step(session)) ?? { kind: "done" };
  }
}

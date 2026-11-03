/** One unattended session of an Agent CLI. */
export interface Session {
  /** The directory the session works in: the Ticket's worktree. */
  cwd: string;
  prompt: string;
  /** Whether the Agent CLI's own sandbox is switched on; the Ticket loop always asks for it. */
  sandbox: boolean;
  timeoutMs: number;
  /** The Stage this session works in; Build unless it is a Ticket's code review. */
  stage?: "build" | "review";
}

export type SessionResult =
  | { kind: "done" }
  | { kind: "failed"; reason: string }
  | { kind: "rate-limited"; until: Date }
  | { kind: "decision"; question: string };

/**
 * The boundary to the Builder's Agent CLI. Each adapter owns its CLI's flags,
 * output parsing, sandbox mode and rate-limit detection; the Ticket loop knows
 * nothing CLI-specific.
 */
export interface AgentCli {
  runSession(session: Session): Promise<SessionResult>;
}

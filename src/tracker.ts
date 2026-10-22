/** A Request, Spec or Ticket as the tracker holds it. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

/** One thing that happened on an issue: a comment, a close or a reopen. */
export type IssueEvent = { kind: "comment"; body: string } | { kind: "closed" } | { kind: "reopened" };

/** The boundary to wherever the Site's issues live (GitHub, through its CLI). */
export interface Tracker {
  /** The Tickets of a Spec: its sub-issues, open or closed. */
  ticketsOf(spec: number): Promise<Issue[]>;
  /** What happened on an issue, oldest first (on GitHub, its timeline). */
  historyOf(issue: number): Promise<IssueEvent[]>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
}

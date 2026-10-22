/** A Request, Spec or Ticket as the tracker holds it. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  /** The issues that block this one (on GitHub, its native issue dependencies). */
  blockedBy: number[];
}

/** One thing that happened on an issue: a comment, a close or a reopen. */
export type IssueEvent = { kind: "comment"; body: string } | { kind: "closed" } | { kind: "reopened" };

/** An open pull request, as the tracker's host (GitHub) shows it. */
export interface PullRequest {
  number: number;
  url: string;
}

/** The boundary to wherever the Site's issues live (GitHub, through its CLI). */
export interface Tracker {
  /** The Tickets of a Spec: its sub-issues, open or closed. */
  ticketsOf(spec: number): Promise<Issue[]>;
  /** Any issue by its number, such as a Spec or a blocker outside the Spec. */
  getIssue(issue: number): Promise<Issue>;
  /** What happened on an issue, oldest first (on GitHub, its timeline). */
  historyOf(issue: number): Promise<IssueEvent[]>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
  /** The open pull request from a branch that has already been pushed, if there is one. */
  pullRequestFrom(head: string): Promise<PullRequest | undefined>;
  openPullRequest(pullRequest: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
}

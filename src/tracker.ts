import type { Stage } from "./stages.ts";

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

/** GitHub refused because nobody is logged in; the Builder has to log in, nothing else helps. */
export class NotLoggedInError extends Error {}

/** The boundary to wherever the Site's issues live (GitHub, through its CLI). */
export interface Tracker {
  /**
   * Files a Request, Spec or Ticket in its Stage. With a `parent` (a Ticket's Spec) the new
   * issue becomes the parent's sub-issue. Returns its number.
   */
  createIssue(issue: { title: string; body: string; stage: Stage; parent?: number }): Promise<number>;
  /** Replaces an issue's title and body, as when a Request becomes its Spec. */
  updateIssue(issue: number, fields: { title: string; body: string }): Promise<void>;
  /** Takes a Ticket out of its Spec for good, for a cut the Builder changed: it is closed and no longer the Spec's sub-issue. */
  removeTicket(spec: number, ticket: number): Promise<void>;
  /** Records that `blocker` blocks `issue` (on GitHub, a native issue dependency). */
  addBlocker(issue: number, blocker: number): Promise<void>;
  /** Moves an issue to a Stage: its one Stage label is replaced, its other labels stay. */
  moveToStage(issue: number, stage: Stage): Promise<void>;
  /** Creates the Stage labels the repository is missing and returns their names; never duplicates one. */
  ensureStageLabels(): Promise<string[]>;
  /** Every label the repository has. */
  labels(): Promise<string[]>;
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

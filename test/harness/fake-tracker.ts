import type { Issue, IssueEvent, Tracker } from "../../src/tracker.ts";

export interface FakeIssue extends Issue {
  parent?: number;
  comments: string[];
  history: IssueEvent[];
}

/** An in-memory stand-in for the Site's GitHub issues. */
export class FakeTracker implements Tracker {
  readonly #issues = new Map<number, FakeIssue>();
  #next = 1;

  addSpec(title: string, body = ""): number {
    return this.#add({ title, body, labels: ["stage:spec"] });
  }

  addTicket(spec: number, title: string, body = "", labels = ["stage:build"]): number {
    return this.#add({ title, body, labels, parent: spec });
  }

  issue(number: number): FakeIssue {
    const issue = this.#issues.get(number);
    if (!issue) throw new Error(`fake tracker has no issue #${number}`);
    return issue;
  }

  /** The Builder reopens an issue, as on GitHub. */
  reopen(number: number): void {
    const issue = this.issue(number);
    issue.state = "open";
    issue.history.push({ kind: "reopened" });
  }

  async ticketsOf(spec: number): Promise<Issue[]> {
    this.issue(spec);
    return [...this.#issues.values()]
      .filter((issue) => issue.parent === spec)
      .map(({ number, title, body, state, labels }) => ({ number, title, body, state, labels: [...labels] }));
  }

  async historyOf(number: number): Promise<IssueEvent[]> {
    return this.issue(number).history.map((event) => ({ ...event }));
  }

  async comment(number: number, body: string): Promise<void> {
    const issue = this.issue(number);
    issue.comments.push(body);
    issue.history.push({ kind: "comment", body });
  }

  async close(number: number): Promise<void> {
    const issue = this.issue(number);
    issue.state = "closed";
    issue.history.push({ kind: "closed" });
  }

  #add(fields: { title: string; body: string; labels: string[]; parent?: number }): number {
    const number = this.#next++;
    this.#issues.set(number, { number, state: "open", comments: [], history: [], ...fields });
    return number;
  }
}

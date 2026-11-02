import { isStageLabel, stageLabel, STAGES, type Stage } from "../../src/stages.ts";
import { NotLoggedInError, type Issue, type IssueEvent, type OpenIssue, type PullRequest, type Tracker } from "../../src/tracker.ts";

export interface FakeIssue extends Issue {
  parent?: number;
  comments: string[];
  history: IssueEvent[];
}

export interface FakePullRequest extends PullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
}

/** An in-memory stand-in for the Site's GitHub issues and pull requests. */
export class FakeTracker implements Tracker {
  readonly #issues = new Map<number, FakeIssue>();
  readonly pullRequests: FakePullRequest[] = [];
  /** The repository's labels; like GitHub, a label is unique regardless of case. */
  readonly #labels: string[] = [];
  #next = 1;
  /** While true, every call refuses, as GitHub does before the Builder logs in. */
  loggedOut = false;

  addSpec(title: string, body = ""): number {
    return this.#add({ title, body, labels: ["stage:spec"] });
  }

  addTicket(spec: number, title: string, body = "", labels = ["stage:build"]): number {
    return this.#add({ title, body, labels, parent: spec });
  }

  /** Records that `blocker` blocks `ticket`, as GitHub's issue dependencies do. */
  block(ticket: number, { by }: { by: number }): void {
    this.issue(ticket).blockedBy.push(by);
  }

  /** The Builder closes an issue by hand. */
  closeByHand(number: number): void {
    this.issue(number).state = "closed";
    this.issue(number).history.push({ kind: "closed" });
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

  /** The Builder creates a label by hand. */
  createLabel(name: string): void {
    if (!this.#hasLabel(name)) this.#labels.push(name);
  }

  /** The Builder deletes a label by hand; like GitHub, it leaves every issue too. */
  deleteLabel(name: string): void {
    const same = (label: string) => label.toLowerCase() === name.toLowerCase();
    this.#labels.splice(0, this.#labels.length, ...this.#labels.filter((label) => !same(label)));
    for (const issue of this.#issues.values()) issue.labels = issue.labels.filter((label) => !same(label));
  }

  async createIssue({ title, body, stage, parent }: { title: string; body: string; stage: Stage; parent?: number }): Promise<number> {
    this.#needsLogin();
    if (parent !== undefined) this.issue(parent);
    return this.#add({ title, body, labels: [stageLabel(stage)], parent });
  }

  async updateIssue(number: number, { title, body }: { title: string; body: string }): Promise<void> {
    this.#needsLogin();
    Object.assign(this.issue(number), { title, body });
  }

  async removeTicket(spec: number, ticket: number): Promise<void> {
    const issue = this.issue(ticket);
    if (issue.parent !== spec) throw new Error(`#${ticket} is not a sub-issue of #${spec}`);
    issue.state = "closed";
    delete issue.parent;
  }

  async addBlocker(number: number, blocker: number): Promise<void> {
    this.issue(blocker);
    const issue = this.issue(number);
    if (!issue.blockedBy.includes(blocker)) issue.blockedBy.push(blocker);
  }

  async moveToStage(number: number, stage: Stage): Promise<void> {
    const issue = this.issue(number);
    issue.labels = [...issue.labels.filter((label) => !isStageLabel(label)), stageLabel(stage)];
    this.createLabel(stageLabel(stage));
  }

  async ensureStageLabels(): Promise<string[]> {
    this.#needsLogin();
    const missing = STAGES.map(stageLabel).filter((label) => !this.#hasLabel(label));
    for (const label of missing) this.createLabel(label);
    return missing;
  }

  async labels(): Promise<string[]> {
    return [...this.#labels];
  }

  async ticketsOf(spec: number): Promise<Issue[]> {
    this.issue(spec);
    return [...this.#issues.values()]
      .filter((issue) => issue.parent === spec)
      .map((issue) => this.#copy(issue));
  }

  async getIssue(number: number): Promise<Issue> {
    this.#needsLogin();
    return this.#copy(this.issue(number));
  }

  async openIssues(): Promise<OpenIssue[]> {
    this.#needsLogin();
    return [...this.#issues.values()]
      .filter((issue) => issue.state === "open")
      .map(({ number, title, labels, parent }) => ({
        number,
        title,
        labels: [...labels],
        url: `https://github.example.test/site/issues/${number}`,
        ...(parent === undefined ? {} : { parent }),
      }));
  }

  async pullRequestFrom(head: string): Promise<PullRequest | undefined> {
    const found = this.pullRequests.find((pr) => pr.head === head && pr.state === "open");
    return found && { number: found.number, url: found.url, body: found.body };
  }

  async mergedPullRequestFrom(head: string): Promise<PullRequest | undefined> {
    const found = this.pullRequests.find((pr) => pr.head === head && pr.state === "merged");
    return found && { number: found.number, url: found.url, body: found.body };
  }

  /** The Builder presses the merge button on GitHub. */
  mergeByHand(number: number): void {
    this.#pullRequest(number).state = "merged";
  }

  /** The Builder closes a pull request on GitHub without merging it. */
  closePullRequestByHand(number: number): void {
    this.#pullRequest(number).state = "closed";
  }

  #pullRequest(number: number): FakePullRequest {
    const found = this.pullRequests.find((pr) => pr.number === number);
    if (!found) throw new Error(`fake tracker has no pull request #${number}`);
    return found;
  }

  async openPullRequest(fields: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const number = this.#next++;
    const url = `https://github.example.test/site/pull/${number}`;
    this.pullRequests.push({ number, url, state: "open", ...fields });
    return { number, url, body: fields.body };
  }

  async updatePullRequest(number: number, { body }: { body: string }): Promise<void> {
    this.#pullRequest(number).body = body;
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

  #needsLogin(): void {
    if (this.loggedOut) throw new NotLoggedInError("To get started with GitHub CLI, please run:  gh auth login");
  }

  #add(fields: { title: string; body: string; labels: string[]; parent?: number }): number {
    const number = this.#next++;
    this.#issues.set(number, { number, state: "open", comments: [], history: [], blockedBy: [], ...fields });
    // GitHub creates a label that an issue is filed with when the repository lacks it.
    for (const label of fields.labels) this.createLabel(label);
    return number;
  }

  #hasLabel(name: string): boolean {
    return this.#labels.some((label) => label.toLowerCase() === name.toLowerCase());
  }

  #copy({ number, title, body, state, labels, blockedBy }: FakeIssue): Issue {
    return { number, title, body, state, labels: [...labels], blockedBy: [...blockedBy] };
  }
}

/** Every method of a tracker, bound to it, so a test can override one or two of them. */
export function delegateTo(tracker: Tracker): Tracker {
  return {
    createIssue: (issue) => tracker.createIssue(issue),
    updateIssue: (issue, fields) => tracker.updateIssue(issue, fields),
    removeTicket: (spec, ticket) => tracker.removeTicket(spec, ticket),
    addBlocker: (issue, blocker) => tracker.addBlocker(issue, blocker),
    moveToStage: (issue, stage) => tracker.moveToStage(issue, stage),
    ensureStageLabels: () => tracker.ensureStageLabels(),
    labels: () => tracker.labels(),
    ticketsOf: (spec) => tracker.ticketsOf(spec),
    getIssue: (issue) => tracker.getIssue(issue),
    openIssues: () => tracker.openIssues(),
    historyOf: (issue) => tracker.historyOf(issue),
    comment: (issue, body) => tracker.comment(issue, body),
    close: (issue) => tracker.close(issue),
    pullRequestFrom: (head) => tracker.pullRequestFrom(head),
    mergedPullRequestFrom: (head) => tracker.mergedPullRequestFrom(head),
    openPullRequest: (pullRequest) => tracker.openPullRequest(pullRequest),
    updatePullRequest: (number, fields) => tracker.updatePullRequest(number, fields),
  };
}

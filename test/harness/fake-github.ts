import type { Gh } from "../../src/github-tracker.ts";

/** Who `gh` is logged in as: the Builder, who owns the repository. */
const BUILDER = "the-builder";

interface Label {
  name: string;
  color: string;
  description: string;
}

interface StoredIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  subIssues: number[];
  blockedBy: number[];
  timeline: Record<string, unknown>[];
}

interface StoredPullRequest {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
}

/** GitHub's own page size is 30 or more; a tiny one makes an adapter that forgets later pages fail. */
const PAGE_SIZE = 2;

class HttpError extends Error {
  constructor(status: number, reason: string, detail?: unknown) {
    super(`gh: ${reason} (HTTP ${status})${detail === undefined ? "" : `\n${JSON.stringify(detail)}`}`);
  }
}

/**
 * An in-memory GitHub repository behind a fake `gh`: it answers the REST calls the GitHub
 * tracker makes through `gh api`, the way GitHub does, including its quirks (issues and
 * pull requests share numbers, ids differ from numbers, labels are unique regardless of
 * case, list endpoints are paged).
 */
export class FakeGitHub {
  readonly repo: string;
  readonly #issues = new Map<number, StoredIssue>();
  readonly #pulls = new Map<number, StoredPullRequest>();
  readonly #labels: Label[] = [];
  readonly #branches = new Set(["main"]);
  #nextNumber = 1;
  #nextId = 7_000_001;

  constructor(repo = "builder/site") {
    this.repo = repo;
  }

  readonly gh: Gh = async (args, { input }) => this.#run(args, input);

  /** While true, `gh` answers as it does before the Builder logs in. */
  loggedOut = false;

  /** Pushes a branch to the fake remote, so a pull request can be opened from it. */
  pushBranch(name: string): void {
    this.#branches.add(name);
  }

  /** The Builder presses the merge button on GitHub. */
  mergeByHand(number: number): void {
    Object.assign(this.#pulls.get(number)!, { state: "closed", merged: true });
  }

  /** The Builder closes a pull request on GitHub without merging it. */
  closePullRequestByHand(number: number): void {
    this.#pulls.get(number)!.state = "closed";
  }

  /** The Builder reopens an issue on GitHub. */
  reopenByHand(number: number): void {
    const issue = this.#issue(number);
    issue.state = "open";
    issue.timeline.push({ event: "reopened" });
  }

  /** Someone without write access comments on an issue, as anyone may on a public repository. */
  commentAsStranger(number: number, body: string, login = "a-stranger"): void {
    this.#issue(number).timeline.push({ event: "commented", body, actor: { login }, user: { login }, author_association: "NONE" });
  }

  /** The Builder creates a label on GitHub. */
  createLabel(name: string): void {
    this.#createLabel({ name });
  }

  /** The Builder deletes a label on GitHub; it leaves every issue too. */
  deleteLabel(name: string): void {
    const index = this.#labels.findIndex((label) => sameLabel(label.name, name));
    if (index >= 0) this.#labels.splice(index, 1);
    for (const issue of this.#issues.values()) issue.labels = issue.labels.filter((label) => !sameLabel(label, name));
  }

  #run(args: string[], input: string | undefined): string {
    if (this.loggedOut) throw new Error("To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.");
    if (args[0] === "repo" && args[1] === "view") return `${this.repo}\n`;
    if (args[0] !== "api") throw new Error(`fake gh does not know "gh ${args.join(" ")}"`);

    let method: string | undefined;
    let paginate = false;
    let slurp = false;
    let body: Record<string, unknown> | undefined;
    let endpoint: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-X" || arg === "--method") method = args[++i];
      else if (arg === "-H" || arg === "--header") i++;
      else if (arg === "--paginate") paginate = true;
      else if (arg === "--slurp") slurp = true;
      else if (arg === "--input" && args[i + 1] === "-") {
        i++;
        body = JSON.parse(input ?? "") as Record<string, unknown>;
      } else if (arg?.startsWith("-")) throw new Error(`fake gh does not know the flag ${arg}`);
      else endpoint = arg;
    }
    if (slurp && !paginate) throw new Error("gh: the `--slurp` option is only supported with `--paginate`");
    if (!endpoint) throw new Error("fake gh got no endpoint");

    const url = new URL(endpoint, "https://api.github.test/");
    const prefix = `/repos/${this.repo}/`;
    if (!url.pathname.startsWith(prefix)) throw new HttpError(404, "Not Found");
    const path = url.pathname.slice(prefix.length);
    const result = this.#route(method ?? (body ? "POST" : "GET"), path, url.searchParams, body ?? {});

    if (!Array.isArray(result)) return result === undefined ? "" : JSON.stringify(result);
    const pages: unknown[][] = [];
    for (let i = 0; i < result.length; i += PAGE_SIZE) pages.push(result.slice(i, i + PAGE_SIZE));
    if (pages.length === 0) pages.push([]);
    if (!paginate) return JSON.stringify(pages[0]);
    return slurp ? JSON.stringify(pages) : pages.map((page) => JSON.stringify(page)).join("");
  }

  #route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): unknown {
    const route = `${method} ${path}`;
    let match: RegExpMatchArray | null;

    if (route === "GET labels") return this.#labels.map((label) => ({ ...label }));
    if (route === "POST labels") return this.#createLabel(body as { name: string; color?: string; description?: string });

    if (route === "POST issues") {
      const number = this.#nextNumber++;
      const labels = (body.labels as string[] | undefined) ?? [];
      const issue: StoredIssue = {
        id: this.#nextId++,
        number,
        title: String(body.title),
        body: String(body.body ?? ""),
        state: "open",
        labels: labels.map((name) => this.#labelFor(name)),
        subIssues: [],
        blockedBy: [],
        timeline: labels.map((name) => ({ event: "labeled", label: { name } })),
      };
      this.#issues.set(number, issue);
      return this.#issueJson(issue);
    }

    if (route === "GET issues") {
      const state = query.get("state") ?? "open";
      // Like GitHub, the list holds pull requests too.
      const issues = [...this.#issues.values()].filter((issue) => state === "all" || issue.state === state).map((issue) => this.#issueJson(issue));
      const pulls = [...this.#pulls.values()]
        .filter((pull) => state === "all" || pull.state === state)
        .map((pull) => ({ id: this.#nextId++, number: pull.number, title: pull.title, body: pull.body, state: pull.state, labels: [], pull_request: {} }));
      return [...issues, ...pulls];
    }

    if ((match = route.match(/^GET issues\/(\d+)$/))) {
      const number = Number(match[1]);
      const pull = this.#pulls.get(number);
      if (pull) return { id: this.#nextId++, number, title: pull.title, body: pull.body, state: pull.state, labels: [], pull_request: {} };
      return this.#issueJson(this.#issue(number));
    }
    if ((match = route.match(/^PATCH issues\/(\d+)$/))) {
      const issue = this.#issue(Number(match[1]));
      if (body.state === "closed" && issue.state === "open") issue.timeline.push({ event: "closed" });
      if (body.state === "open" && issue.state === "closed") issue.timeline.push({ event: "reopened" });
      if (body.state === "open" || body.state === "closed") issue.state = body.state;
      if (typeof body.title === "string") issue.title = body.title;
      if (typeof body.body === "string") issue.body = body.body;
      return this.#issueJson(issue);
    }
    if ((match = route.match(/^PUT issues\/(\d+)\/labels$/))) {
      const issue = this.#issue(Number(match[1]));
      issue.labels = (body.labels as string[]).map((name) => this.#labelFor(name));
      return issue.labels.map((name) => ({ name }));
    }
    if ((match = route.match(/^POST issues\/(\d+)\/comments$/))) {
      const issue = this.#issue(Number(match[1]));
      // gh is logged in as the Builder, who owns the repository.
      issue.timeline.push({ event: "commented", body: String(body.body), actor: { login: BUILDER }, user: { login: BUILDER }, author_association: "OWNER" });
      return { id: this.#nextId++, body: body.body };
    }
    if ((match = route.match(/^GET issues\/(\d+)\/timeline$/))) {
      return this.#issue(Number(match[1])).timeline.map((event) => ({ ...event }));
    }
    if ((match = route.match(/^POST issues\/(\d+)\/sub_issues$/))) {
      const parent = this.#issue(Number(match[1]));
      const child = this.#issueById(body.sub_issue_id);
      if (!parent.subIssues.includes(child.number)) parent.subIssues.push(child.number);
      parent.timeline.push({ event: "sub_issue_added" });
      return this.#issueJson(parent);
    }
    if ((match = route.match(/^DELETE issues\/(\d+)\/sub_issue$/))) {
      const parent = this.#issue(Number(match[1]));
      const child = this.#issueById(body.sub_issue_id);
      if (!parent.subIssues.includes(child.number)) throw new HttpError(404, "Not Found");
      parent.subIssues = parent.subIssues.filter((number) => number !== child.number);
      return this.#issueJson(child);
    }
    if ((match = route.match(/^GET issues\/(\d+)\/sub_issues$/))) {
      return this.#issue(Number(match[1])).subIssues.map((number) => this.#issueJson(this.#issue(number)));
    }
    if ((match = route.match(/^POST issues\/(\d+)\/dependencies\/blocked_by$/))) {
      const issue = this.#issue(Number(match[1]));
      const blocker = this.#issueById(body.issue_id);
      if (issue.blockedBy.includes(blocker.number)) throw new HttpError(422, "Validation Failed");
      issue.blockedBy.push(blocker.number);
      return this.#issueJson(blocker);
    }
    if ((match = route.match(/^GET issues\/(\d+)\/dependencies\/blocked_by$/))) {
      return this.#issue(Number(match[1])).blockedBy.map((number) => this.#issueJson(this.#issue(number)));
    }

    if (route === "GET pulls") {
      const [owner, name] = (query.get("head") ?? ":").split(":");
      const head = name === undefined ? owner : owner === this.repo.split("/")[0] ? name : undefined;
      const state = query.get("state") ?? "open";
      return [...this.#pulls.values()]
        .filter((pull) => (head === undefined || pull.head === head) && (state === "all" || pull.state === state))
        .map((pull) => this.#pullJson(pull));
    }
    if (route === "POST pulls") {
      const head = String(body.head);
      const base = String(body.base);
      if (!this.#branches.has(head) || !this.#branches.has(base)) throw new HttpError(422, "Validation Failed");
      if ([...this.#pulls.values()].some((pull) => pull.head === head && pull.state === "open")) {
        throw new HttpError(422, "Validation Failed");
      }
      const pull: StoredPullRequest = { number: this.#nextNumber++, head, base, title: String(body.title), body: String(body.body ?? ""), state: "open", merged: false };
      this.#pulls.set(pull.number, pull);
      return this.#pullJson(pull);
    }

    if ((match = route.match(/^PATCH pulls\/(\d+)$/))) {
      const pull = this.#pulls.get(Number(match[1]));
      if (!pull) throw new HttpError(404, "Not Found");
      pull.body = String(body.body);
      return this.#pullJson(pull);
    }

    throw new Error(`fake gh does not know the endpoint "${route}"`);
  }

  #createLabel({ name, color = "ededed", description = "" }: { name: string; color?: string; description?: string }): Label {
    if (this.#labels.some((label) => sameLabel(label.name, name))) {
      throw new HttpError(422, "Validation Failed", { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] });
    }
    const label = { name, color, description };
    this.#labels.push(label);
    return { ...label };
  }

  /** The label an issue is given by this name: an existing one regardless of case, or a new one, as on GitHub. */
  #labelFor(name: string): string {
    return this.#labels.find((label) => sameLabel(label.name, name))?.name ?? this.#createLabel({ name }).name;
  }

  #issue(number: number): StoredIssue {
    const issue = this.#issues.get(number);
    if (!issue) throw new HttpError(404, "Not Found");
    return issue;
  }

  #issueById(id: unknown): StoredIssue {
    const issue = [...this.#issues.values()].find((candidate) => candidate.id === id);
    if (!issue) throw new HttpError(422, "Validation Failed");
    return issue;
  }

  #issueJson(issue: StoredIssue): Record<string, unknown> {
    const parent = [...this.#issues.values()].find((candidate) => candidate.subIssues.includes(issue.number));
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body === "" ? null : issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      html_url: `https://github.test/${this.repo}/issues/${issue.number}`,
      parent_issue_url: parent ? `https://api.github.test/repos/${this.repo}/issues/${parent.number}` : null,
    };
  }

  #pullJson(pull: StoredPullRequest): Record<string, unknown> {
    return { number: pull.number, html_url: `https://github.test/${this.repo}/pull/${pull.number}`, body: pull.body === "" ? null : pull.body, state: pull.state, merged_at: pull.merged ? "2026-11-02T10:00:00Z" : null };
  }
}

function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

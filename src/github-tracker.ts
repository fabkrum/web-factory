import { spawn } from "node:child_process";
import { DECISION_STAGES, isStageLabel, stageLabel, STAGES, type Stage } from "./stages.ts";
import { NotLoggedInError, type Issue, type IssueEvent, type PullRequest, type Tracker } from "./tracker.ts";

/** Runs the GitHub CLI with these arguments and returns what it printed. */
export type Gh = (args: string[], options: { cwd: string; input?: string }) => Promise<string>;

/** The real GitHub CLI, `gh`, as installed on the Builder's machine. */
export function ghCli(command = "gh"): Gh {
  return (args, { cwd, input }) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "ENOENT"
            ? new Error("The GitHub CLI (gh) is not installed, so the Factory cannot reach your issues on GitHub.")
            : error,
        ),
      );
      child.on("close", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh ${args[0] ?? ""} failed with exit code ${code}`)),
      );
      child.stdin.end(input ?? "");
    });
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: (string | { name: string })[];
  pull_request?: unknown;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
}

interface GitHubTimelineEvent {
  event?: string;
  body?: string | null;
}

/** Decision stages are blue and Automatic stages green, as on the board. */
const DECISION_COLOR = "0969da";
const AUTOMATIC_COLOR = "1a7f37";

/**
 * The tracker on GitHub, through its CLI: Requests, Specs and Tickets are issues in the
 * Site's repository, Tickets are sub-issues of their Spec, blockers are native issue
 * dependencies, each Stage is one label, and reasons are comments.
 */
export class GitHubTracker implements Tracker {
  readonly #cwd: string;
  readonly #gh: Gh;
  #repo: string | undefined;

  /** Without `repo`, the repository is the one `gh` finds for the Site's directory. */
  constructor(options: { cwd: string; repo?: string; gh?: Gh }) {
    this.#cwd = options.cwd;
    this.#repo = options.repo;
    this.#gh = options.gh ?? ghCli();
  }

  async createIssue({ title, body, stage, parent }: { title: string; body: string; stage: Stage; parent?: number }): Promise<number> {
    const created = (await this.#api("POST", "issues", { title, body, labels: [stageLabel(stage)] })) as GitHubIssue;
    if (parent !== undefined) await this.#api("POST", `issues/${parent}/sub_issues`, { sub_issue_id: created.id });
    return created.number;
  }

  async updateIssue(issue: number, { title, body }: { title: string; body: string }): Promise<void> {
    await this.#api("PATCH", `issues/${issue}`, { title, body });
  }

  async removeTicket(spec: number, ticket: number): Promise<void> {
    const { id, state } = await this.#issue(ticket);
    if (state === "open") await this.#api("PATCH", `issues/${ticket}`, { state: "closed", state_reason: "not_planned" });
    await this.#api("DELETE", `issues/${spec}/sub_issue`, { sub_issue_id: id });
  }

  async addBlocker(issue: number, blocker: number): Promise<void> {
    const { id } = await this.#issue(blocker);
    await this.#api("POST", `issues/${issue}/dependencies/blocked_by`, { issue_id: id });
  }

  async moveToStage(issue: number, stage: Stage): Promise<void> {
    const labels = labelNames(await this.#issue(issue)).filter((label) => !isStageLabel(label));
    await this.#api("PUT", `issues/${issue}/labels`, { labels: [...labels, stageLabel(stage)] });
  }

  async ensureStageLabels(): Promise<string[]> {
    const existing = new Set((await this.labels()).map((label) => label.toLowerCase()));
    const created: string[] = [];
    for (const stage of STAGES) {
      const name = stageLabel(stage);
      if (existing.has(name)) continue;
      const decision = DECISION_STAGES.includes(stage);
      try {
        await this.#api("POST", "labels", {
          name,
          color: decision ? DECISION_COLOR : AUTOMATIC_COLOR,
          description: decision ? "Pipeline Stage: waits for you" : "Pipeline Stage: runs by itself",
        });
        created.push(name);
      } catch (error) {
        // Created by someone else since the list was read: it exists, which is all we need.
        if (!(error instanceof Error && /already_exists/.test(error.message))) throw error;
      }
    }
    return created;
  }

  async labels(): Promise<string[]> {
    const labels = (await this.#list("labels")) as { name: string }[];
    return labels.map((label) => label.name);
  }

  async ticketsOf(spec: number): Promise<Issue[]> {
    const subIssues = (await this.#list(`issues/${spec}/sub_issues`)) as GitHubIssue[];
    return Promise.all(subIssues.map((issue) => this.#toIssue(issue)));
  }

  async getIssue(issue: number): Promise<Issue> {
    return this.#toIssue(await this.#issue(issue));
  }

  async historyOf(issue: number): Promise<IssueEvent[]> {
    const timeline = (await this.#list(`issues/${issue}/timeline`)) as GitHubTimelineEvent[];
    const history: IssueEvent[] = [];
    for (const event of timeline) {
      if (event.event === "commented") history.push({ kind: "comment", body: event.body ?? "" });
      if (event.event === "closed") history.push({ kind: "closed" });
      if (event.event === "reopened") history.push({ kind: "reopened" });
    }
    return history;
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.#api("POST", `issues/${issue}/comments`, { body });
  }

  async close(issue: number): Promise<void> {
    await this.#api("PATCH", `issues/${issue}`, { state: "closed" });
  }

  async pullRequestFrom(head: string): Promise<PullRequest | undefined> {
    const owner = (await this.#repository()).split("/")[0];
    const query = new URLSearchParams({ state: "open", head: `${owner}:${head}` });
    const [found] = (await this.#list(`pulls?${query}`)) as GitHubPullRequest[];
    return found && { number: found.number, url: found.html_url };
  }

  async openPullRequest(pullRequest: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const opened = (await this.#api("POST", "pulls", pullRequest)) as GitHubPullRequest;
    return { number: opened.number, url: opened.html_url };
  }

  async #toIssue(issue: GitHubIssue): Promise<Issue> {
    const blockers = (await this.#list(`issues/${issue.number}/dependencies/blocked_by`)) as GitHubIssue[];
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: labelNames(issue),
      blockedBy: blockers.map((blocker) => blocker.number),
    };
  }

  async #issue(number: number): Promise<GitHubIssue> {
    const issue = (await this.#api("GET", `issues/${number}`)) as GitHubIssue;
    // GitHub numbers pull requests and issues together; a pull request is not a Request, Spec or Ticket.
    if (issue.pull_request !== undefined) throw new Error(`#${number} is a pull request, not an issue.`);
    return issue;
  }

  async #run(args: string[], input?: string): Promise<string> {
    try {
      return await this.#gh(args, { cwd: this.#cwd, input });
    } catch (error) {
      // gh ends every complaint about a missing or expired login with this advice.
      if (error instanceof Error && /gh auth login/.test(error.message)) throw new NotLoggedInError(error.message);
      throw error;
    }
  }

  async #repository(): Promise<string> {
    this.#repo ??= (await this.#run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
    return this.#repo;
  }

  async #api(method: string, path: string, body?: unknown): Promise<unknown> {
    const args = ["api", "-X", method, `repos/${await this.#repository()}/${path}`, ...API_HEADERS];
    if (body !== undefined) args.push("--input", "-");
    const output = await this.#run(args, body === undefined ? undefined : JSON.stringify(body));
    return output.trim() === "" ? undefined : JSON.parse(output);
  }

  /** Every item of a list endpoint, across all its pages. */
  async #list(path: string): Promise<unknown[]> {
    const separator = path.includes("?") ? "&" : "?";
    const args = ["api", `repos/${await this.#repository()}/${path}${separator}per_page=100`, "--paginate", "--slurp", ...API_HEADERS];
    const pages = JSON.parse(await this.#run(args)) as unknown[][];
    return pages.flat();
  }
}

const API_HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels.map((label) => (typeof label === "string" ? label : label.name));
}

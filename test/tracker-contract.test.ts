import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ghCli, GitHubTracker } from "../src/github-tracker.ts";
import { FakeGitHub } from "./harness/fake-github.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { trackerContract } from "./harness/tracker-contract.ts";

trackerContract("the fake tracker", async () => {
  const tracker = new FakeTracker();
  return {
    tracker,
    pushBranch: async () => "main",
    reopenByHand: async (issue) => tracker.reopen(issue),
    createLabel: async (name) => tracker.createLabel(name),
    deleteLabel: async (name) => tracker.deleteLabel(name),
  };
});

trackerContract("the GitHub tracker against a fake GitHub", async () => {
  const github = new FakeGitHub();
  return {
    tracker: new GitHubTracker({ cwd: process.cwd(), repo: github.repo, gh: github.gh }),
    pushBranch: async (name) => {
      github.pushBranch(name);
      return "main";
    },
    reopenByHand: async (issue) => github.reopenByHand(issue),
    createLabel: async (name) => github.createLabel(name),
    deleteLabel: async (name) => github.deleteLabel(name),
  };
});

/**
 * The real contract: the GitHub tracker against a disposable GitHub repository, which must
 * have at least one commit on its default branch. CI sets WEB_FACTORY_CONTRACT_REPO
 * (owner/name) and GH_TOKEN from the maintainer's secret; without them it is skipped.
 */
const contractRepo = process.env.WEB_FACTORY_CONTRACT_REPO;
trackerContract("the GitHub tracker against a disposable GitHub repository", async () => realSubject(contractRepo!), {
  skip: realContractSkipReason(),
  timeout: 120_000,
});

function realContractSkipReason(): string | undefined {
  if (!contractRepo) {
    return "WEB_FACTORY_CONTRACT_REPO is not set; set it to a disposable repository (owner/name) and GH_TOKEN to a token that may write its issues, pull requests and contents";
  }
  if (!process.env.GH_TOKEN) {
    return "GH_TOKEN is not set; in CI it comes from the CONTRACT_GH_TOKEN secret, a token that may write the disposable repository's issues, pull requests and contents";
  }
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return "the GitHub CLI (gh) is not installed";
  }
  return undefined;
}

async function realSubject(repo: string) {
  const gh = ghCli();
  const api = async (method: string, path: string, body?: unknown) => {
    const args = ["api", "-X", method, `repos/${repo}${path === "" ? "" : `/${path}`}`];
    if (body !== undefined) args.push("--input", "-");
    const output = await gh(args, { cwd: process.cwd(), input: body === undefined ? undefined : JSON.stringify(body) });
    return output.trim() === "" ? undefined : JSON.parse(output);
  };
  return {
    tracker: new GitHubTracker({ cwd: process.cwd(), repo }),
    pushBranch: async (name: string) => {
      const { default_branch: base } = await api("GET", "");
      const { object } = await api("GET", `git/ref/heads/${base}`);
      await api("POST", "git/refs", { ref: `refs/heads/${name}`, sha: object.sha });
      await api("PUT", `contents/contract/${name.replaceAll("/", "-")}.md`, {
        message: "A commit of the branch's own, so a pull request can be opened from it",
        content: Buffer.from(`${name}\n`).toString("base64"),
        branch: name,
      });
      return base as string;
    },
    reopenByHand: async (issue: number) => void (await api("PATCH", `issues/${issue}`, { state: "open" })),
    createLabel: async (name: string) => void (await api("POST", "labels", { name })),
    deleteLabel: async (name: string) => {
      try {
        await api("DELETE", `labels/${encodeURIComponent(name)}`);
      } catch (error) {
        if (!(error instanceof Error && /HTTP 404/.test(error.message))) throw error;
      }
    },
  };
}

describe("the GitHub tracker", () => {
  it("finds the Site's repository through gh when it is not told one", async () => {
    const github = new FakeGitHub("someone/their-site");
    const tracker = new GitHubTracker({ cwd: process.cwd(), gh: github.gh });

    const spec = await tracker.createIssue({ title: "A Spec", body: "", stage: "spec" });

    expect((await tracker.getIssue(spec)).title).toBe("A Spec");
  });

  it("does not take a pull request for an issue", async () => {
    const github = new FakeGitHub();
    github.pushBranch("loop/spec-1");
    const tracker = new GitHubTracker({ cwd: process.cwd(), repo: github.repo, gh: github.gh });
    const pull = await tracker.openPullRequest({ head: "loop/spec-1", base: "main", title: "Spec 1", body: "" });

    await expect(tracker.getIssue(pull.number)).rejects.toThrow(/pull request, not an issue/);
  });

  it("says in plain words when the GitHub CLI is missing", async () => {
    const tracker = new GitHubTracker({ cwd: process.cwd(), repo: "builder/site", gh: ghCli("gh-that-is-not-installed") });

    await expect(tracker.getIssue(1)).rejects.toThrow("The GitHub CLI (gh) is not installed");
  });
});

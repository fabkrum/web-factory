import { afterEach, describe, expect, it } from "vitest";
import { GitHubTracker } from "../src/github-tracker.ts";
import { redactSecrets, siteEnvironment } from "../src/secrets.ts";
import { runShell } from "../src/shell.ts";
import { FakeAgentCli } from "./harness/fake-agent-cli.ts";
import { FakeGitHub } from "./harness/fake-github.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo } from "./harness/site-repo.ts";

/** Values shaped like the real ones, so a token pattern would catch them too; none of them is real. */
const GH_TOKEN = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;
const ANTHROPIC_API_KEY = `sk-ant-api03-${"x9Y8z7W6v5".repeat(4)}`;
const CLAUDE_CODE_OAUTH_TOKEN = "oauth-value-without-a-known-shape-123456";

const saved = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

function withSecrets(): void {
  Object.assign(process.env, { GH_TOKEN, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, MY_SERVICE_PASSWORD: "hunter2-hunter2" });
}

describe("the Site's commands and secrets", () => {
  it("run without the Factory's tokens and keys, with everything else they need", async () => {
    withSecrets();
    process.env.SITE_FLAVOUR = "plain";

    const run = await runShell(process.cwd(), 'echo "gh=$GH_TOKEN anthropic=$ANTHROPIC_API_KEY claude=$CLAUDE_CODE_OAUTH_TOKEN pw=$MY_SERVICE_PASSWORD flavour=$SITE_FLAVOUR"; command -v sh');

    expect(run.output).toContain("gh= anthropic= claude= pw= flavour=plain");
    expect(run.output).toMatch(/\/sh\n/);
  });

  it("keeps PATH, HOME and the rest of an ordinary environment", () => {
    const env = siteEnvironment({ PATH: "/bin", HOME: "/home/b", LANG: "C", CI: "true", NODE_ENV: "test", GITHUB_TOKEN: "x", OPENAI_API_KEY: "y", AWS_SECRET_ACCESS_KEY: "z", NPM_TOKEN: "n", GOOGLE_APPLICATION_CREDENTIALS: "/k.json" });

    expect(env).toEqual({ PATH: "/bin", HOME: "/home/b", LANG: "C", CI: "true", NODE_ENV: "test" });
  });

  it("never reach a park comment, even when the Site's red test prints them", async () => {
    withSecrets();
    const site = createSiteRepo({ testCommand: 'echo "token: $GH_TOKEN key: $ANTHROPIC_API_KEY"; exit 1' });
    const tracker = new FakeTracker();
    const spec = tracker.addSpec("A greeting page");
    const ticket = tracker.addTicket(spec, "Say hello");
    let round = 0;
    const hello = ({ cwd }: { cwd: string }) => void commitFile(cwd, "index.html", `<h1>hello ${++round}</h1>\n`);

    await runFactory(["loop", String(spec)], { cwd: site, agentCli: new FakeAgentCli(hello, hello, hello), tracker });

    const comments = tracker.issue(ticket).comments.join("\n");
    expect(comments).toMatch(/^Parked\./m);
    expect(comments).toContain("token:  key:");
    expect(comments).not.toContain(GH_TOKEN);
    expect(comments).not.toContain(ANTHROPIC_API_KEY);
  });
});

describe("redacting secrets from what goes to the tracker", () => {
  it("masks the value of every secret in the Factory's environment", () => {
    const text = redactSecrets(`login with ${CLAUDE_CODE_OAUTH_TOKEN} and hunter2-hunter2`, { CLAUDE_CODE_OAUTH_TOKEN, MY_SERVICE_PASSWORD: "hunter2-hunter2", PATH: "/usr/bin" });

    expect(text).toBe("login with [redacted] and [redacted]");
  });

  it("masks tokens by their shape, also ones the Factory never held", () => {
    const text = redactSecrets(
      [GH_TOKEN, `github_pat_${"1".repeat(22)}_${"a".repeat(59)}`, ANTHROPIC_API_KEY, `sk-proj-${"Q".repeat(40)}`, `AIza${"b".repeat(35)}`].join(" "),
      {},
    );

    expect(text).toBe("[redacted] [redacted] [redacted] [redacted] [redacted]");
  });

  it("leaves ordinary text, short values and the PATH alone", () => {
    const text = "The Site's test command `npm test` is red (exit code 1). sk-1 /usr/bin task-runner";

    expect(redactSecrets(text, { PATH: "/usr/bin", API_KEY: "abc" })).toBe(text);
  });

  it("is done by the GitHub tracker for every comment, issue and pull request it writes", async () => {
    withSecrets();
    const github = new FakeGitHub();
    const tracker = new GitHubTracker({ cwd: process.cwd(), repo: github.repo, gh: github.gh });
    const issue = await tracker.createIssue({ title: `Leaks ${GH_TOKEN}`, body: `body ${ANTHROPIC_API_KEY}`, stage: "build" });

    await tracker.comment(issue, `Parked. The tests printed ${CLAUDE_CODE_OAUTH_TOKEN}`);
    await tracker.updateIssue(issue, { title: "Still fine", body: `again ${GH_TOKEN}` });

    const written = JSON.stringify([await tracker.getIssue(issue), await tracker.historyOf(issue)]);
    expect(written).toContain("[redacted]");
    expect(written).not.toContain(GH_TOKEN);
    expect(written).not.toContain(ANTHROPIC_API_KEY);
    expect(written).not.toContain(CLAUDE_CODE_OAUTH_TOKEN);
  });
});

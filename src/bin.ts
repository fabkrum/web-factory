import { ClaudeCode } from "./claude-code.ts";
import { factory } from "./cli.ts";
import { GitHubTracker } from "./github-tracker.ts";

process.exitCode = await factory(process.argv.slice(2), {
  cwd: process.cwd(),
  // The only Agent CLI adapter so far; Kickoff records the Builder's choice once there are more.
  agentCli: new ClaudeCode(),
  tracker: new GitHubTracker({ cwd: process.cwd() }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

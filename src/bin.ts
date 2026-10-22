import type { AgentCli } from "./agent-cli.ts";
import { ClaudeCode } from "./claude-code.ts";
import { factory } from "./cli.ts";
import { Codex } from "./codex.ts";
import { ConfigError, readAgentCliChoice, type AgentCliName } from "./config.ts";
import { GitHubTracker } from "./github-tracker.ts";

const ADAPTERS: Record<AgentCliName, () => AgentCli> = {
  "claude-code": () => new ClaudeCode(),
  codex: () => new Codex(),
};

let agentCli: AgentCli;
try {
  // Kickoff records the Builder's choice in factory.json; until then it is Claude Code.
  agentCli = ADAPTERS[await readAgentCliChoice(process.cwd())]();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

process.exitCode = await factory(process.argv.slice(2), {
  cwd: process.cwd(),
  agentCli,
  tracker: new GitHubTracker({ cwd: process.cwd() }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

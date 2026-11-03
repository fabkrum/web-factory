import type { AgentCli } from "./agent-cli.ts";
import { ClaudeCode } from "./claude-code.ts";
import { openInBrowser } from "./board.ts";
import { factory } from "./cli.ts";
import { Codex } from "./codex.ts";
import { ConfigError, readAgentCliChoice, readHostChoice, type AgentCliName } from "./config.ts";
import { FirebaseHost } from "./firebase-host.ts";
import { GitHubTracker } from "./github-tracker.ts";
import { GoogleCli } from "./google-cli.ts";
import { isFirebaseHosting } from "./host.ts";
import { NpmReleases } from "./releases.ts";
import { CRUX_KEY_VARIABLE, CruxApi } from "./crux.ts";
import { measureLive } from "./review/lighthouse.ts";

const ADAPTERS: Record<AgentCliName, () => AgentCli> = {
  "claude-code": () => new ClaudeCode(),
  codex: () => new Codex(),
  antigravity: () => new GoogleCli({ cli: "antigravity" }),
  gemini: () => new GoogleCli({ cli: "gemini" }),
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

const hostChoice = await readHostChoice(process.cwd());
const cruxKey = process.env[CRUX_KEY_VARIABLE];

process.exitCode = await factory(process.argv.slice(2), {
  cwd: process.cwd(),
  agentCli,
  tracker: new GitHubTracker({ cwd: process.cwd() }),
  host: hostChoice !== undefined && isFirebaseHosting(hostChoice) ? new FirebaseHost() : undefined,
  releases: new NpmReleases({ cwd: process.cwd() }),
  measureLab: measureLive,
  crux: cruxKey ? new CruxApi({ key: cruxKey }) : undefined,
  openBrowser: openInBrowser,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

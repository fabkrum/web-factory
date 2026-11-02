// Seam 3: runs the fixed sample Spec through the Ticket loop on one real Agent CLI, spending
// real model usage, and reports Pass, the parked reason or why it was skipped.
// Usage, from the root of the repository: node test/ci/sample-spec.ts <agent-cli>
import { AGENT_CLIS, type AgentCliName } from "../../src/config.ts";
import { addToJobSummary, describeRun, runNightly } from "../harness/sample-spec.ts";

const cli = process.argv[2] as AgentCliName;
if (process.argv.length !== 3 || !AGENT_CLIS.includes(cli)) {
  process.stderr.write(`Name one Agent CLI: ${AGENT_CLIS.join(", ")}\n`);
  process.exit(2);
}

const run = await runNightly(cli, process.env, (text) => process.stderr.write(text));
const line = describeRun(cli, run);
process.stdout.write(line);
addToJobSummary(line, process.env);
process.exitCode = run.outcome === "pass" || run.outcome === "skipped" ? 0 : 1;

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, readSiteConfig } from "../config.ts";
import { runShell } from "../shell.ts";
import type { Failure, ReviewCheck } from "./check.ts";

/** How long the Site's own tests may run before the review stops them and fails the check. */
const TEST_TIMEOUT = 15 * 60 * 1000;

/** How many of the last lines a red test command printed go into the reason. */
const OUTPUT_TAIL_LINES = 15;

export const siteTestsCheck: ReviewCheck = {
  id: "code/site-tests",
  name: "The Site's own tests",
  area: "Code & security",
  needsRepo: true,
  async run(site) {
    let testCommand: string;
    try {
      ({ testCommand } = await readSiteConfig(site.repo!));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      return [{ reason: error.message, location: "factory.json" }];
    }
    const location = `the Site's test command, ${testCommand}`;
    const run = await runShell(site.repo!, testCommand, TEST_TIMEOUT);
    const tail = run.output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
    if (run.timedOut) {
      return [{ reason: `The Site's own tests did not finish within ${TEST_TIMEOUT / 60_000} minutes, so the review stopped them. A test is probably waiting for something that never comes.${tail ? ` The last thing they printed:\n${tail}` : ""}`, location }];
    }
    if (run.exitCode === 0) return [];
    return [
      {
        reason: `The Site's own tests are red: the test command ended with exit code ${run.exitCode}, so something the Site's tests check is broken. Run it in your Site's folder to see every failure.${tail ? ` The last thing it printed:\n${tail}` : ""}`,
        location,
      },
    ];
  },
};

/** One package npm audit found a known advisory for, as `npm audit --json` reports it. */
interface Vulnerability {
  name: string;
  isDirect: boolean;
  /** The advisories against this package itself, and the names of vulnerable packages it depends on. */
  via: (string | { source: number; title: string; url: string; severity: string; range: string })[];
  /** The installed packages that depend on this one. */
  effects: string[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

/** Advisories npm marks "info" are notes, not holes. */
const SEVERITIES = ["low", "moderate", "high", "critical"];

export const advisoriesCheck: ReviewCheck = {
  id: "security/advisories",
  name: "No known advisories in the dependencies",
  area: "Code & security",
  needsRepo: true,
  async run(site) {
    const repo = site.repo!;
    if (!(await exists(join(repo, "package.json")))) return [];
    if (!(await exists(join(repo, "package-lock.json"))) && !(await exists(join(repo, "npm-shrinkwrap.json")))) {
      const other = (await exists(join(repo, "pnpm-lock.yaml"))) ? "pnpm-lock.yaml" : (await exists(join(repo, "yarn.lock"))) ? "yarn.lock" : undefined;
      if (other) {
        return {
          notRun: `Not run: this Site locks its dependencies in ${other}, and this check can so far only read npm's package-lock.json, so the review has not checked the dependencies for known advisories. That is a gap in the review, not a fault of the Site; check them with your package manager's own audit command.`,
        };
      }
      return [
        {
          reason: "This Site has a package.json but no package-lock.json, so nothing fixes which versions of its dependencies get installed, and the review cannot check them for known advisories. Run npm install in your Site's folder and commit the package-lock.json it writes.",
          location: "package-lock.json",
        },
      ];
    }
    const audit = await npmAudit(repo);
    if ("error" in audit) {
      return [
        {
          reason: `The review could not ask the npm registry for known advisories (${audit.error}), so it could not check the dependencies. Check your internet connection, then run the review again.`,
          location: "package-lock.json",
        },
      ];
    }
    const failures: Failure[] = [];
    for (const vulnerability of Object.values(audit.vulnerabilities)) {
      for (const advisory of vulnerability.via) {
        if (typeof advisory === "string" || !SEVERITIES.includes(advisory.severity)) continue;
        const through = vulnerability.isDirect || vulnerability.effects.length === 0 ? "" : ` It comes into the Site through ${vulnerability.effects.join(", ")}.`;
        failures.push({
          reason: `${vulnerability.name} has a known security advisory, ${advisory.severity} severity: "${advisory.title}" (${advisory.url}). Versions ${advisory.range} are affected.${through} ${fix(vulnerability)}`,
          location: `${vulnerability.name} in package-lock.json`,
        });
      }
    }
    return failures;
  },
};

/** What the Builder can do about one vulnerable package, from what npm says it can fix. */
function fix({ name, fixAvailable }: Vulnerability): string {
  if (fixAvailable === false) {
    return `No fixed version is out yet: replace ${name} with another package or remove it, or wait for a fix and run the review again.`;
  }
  if (fixAvailable === true) return "Run npm audit fix in your Site's folder to move to versions without it, then commit package-lock.json.";
  if (fixAvailable.isSemVerMajor) {
    return `The fix is ${fixAvailable.name} ${fixAvailable.version}, a major version that may change how it works: update to it, check the Site still works, and commit package-lock.json.`;
  }
  return `Update ${fixAvailable.name} to ${fixAvailable.version} (npm audit fix in your Site's folder does that), then commit package-lock.json.`;
}

/**
 * Runs `npm audit` on the Site's lockfile, with the registry and settings its
 * own .npmrc names. npm exits 1 whenever it finds an advisory, so only its JSON
 * tells a finding from a failure.
 */
async function npmAudit(repo: string): Promise<{ vulnerabilities: Record<string, Vulnerability> } | { error: string }> {
  const { output, spawnError } = await new Promise<{ output: string; spawnError?: string }>((resolve) => {
    const child = spawn("npm", ["audit", "--json", "--package-lock-only"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => resolve({ output, spawnError: error.message }));
    child.on("close", () => resolve({ output }));
  });
  if (spawnError) return { error: `npm could not be started: ${spawnError}` };
  let report: { vulnerabilities?: Record<string, Vulnerability>; error?: { summary?: string; code?: string } };
  try {
    report = JSON.parse(output) as typeof report;
  } catch {
    return { error: "npm audit gave no answer the review could read" };
  }
  if (report.error || !report.vulnerabilities) return { error: report.error?.summary?.split("\n")[0] || report.error?.code || "npm audit reported an error" };
  return { vulnerabilities: report.vulnerabilities };
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

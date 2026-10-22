import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The Site's Factory settings, recorded at Kickoff in `factory.json`. */
export interface SiteConfig {
  /** What green means for the Site's stack, run with `sh -c` in the Ticket's worktree. */
  testCommand: string;
  /** The branch the Builder publishes from; the Ticket loop never moves it. */
  baseBranch: string;
  sessionTimeoutMs: number;
}

export const CONFIG_FILE = "factory.json";

export class ConfigError extends Error {}

export async function readSiteConfig(siteDir: string): Promise<SiteConfig> {
  let raw: string;
  try {
    raw = await readFile(join(siteDir, CONFIG_FILE), "utf8");
  } catch {
    throw new ConfigError(`This folder has no ${CONFIG_FILE}, so it is not a Site the Factory has set up. Run factory from your Site's folder.`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON.`);
  }
  const { testCommand, baseBranch = "main", sessionTimeoutMs = 60 * 60 * 1000 } = parsed;
  if (typeof testCommand !== "string" || testCommand.trim() === "") {
    throw new ConfigError(`${CONFIG_FILE} has no testCommand, so the Ticket loop cannot tell whether a Ticket is green.`);
  }
  if (typeof baseBranch !== "string" || typeof sessionTimeoutMs !== "number") {
    throw new ConfigError(`${CONFIG_FILE} has a baseBranch or sessionTimeoutMs of the wrong type.`);
  }
  return { testCommand, baseBranch, sessionTimeoutMs };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The Site's Factory settings, recorded at Kickoff in `factory.json`. */
export interface SiteConfig {
  /** What green means for the Site's stack, run with `sh -c` in the Ticket's worktree. */
  testCommand: string;
  /** The branch the Builder publishes from; the Ticket loop never moves it. */
  baseBranch: string;
  sessionTimeoutMs: number;
  /** How many Build sessions a Ticket gets in one run before it parks. */
  maxAttempts: number;
  /** Builds the Site for Review, run with `sh -c` in the Ticket's worktree; a Site with no build step has none. */
  buildCommand?: string;
  /**
   * Serves the built Site for Review, run with `sh -c` in the Ticket's worktree. It listens on
   * the port it gets as `{port}` in the command or as PORT. The Ticket loop refuses a Site without it.
   */
  serveCommand?: string;
  /** How long the Site gets to answer once its serve command runs. */
  serveTimeoutMs: number;
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
  const { testCommand, baseBranch = "main", sessionTimeoutMs = 60 * 60 * 1000, maxAttempts = 3, buildCommand, serveCommand, serveTimeoutMs = 60 * 1000 } = parsed;
  if (typeof testCommand !== "string" || testCommand.trim() === "") {
    throw new ConfigError(`${CONFIG_FILE} has no testCommand, so the Ticket loop cannot tell whether a Ticket is green.`);
  }
  if (typeof baseBranch !== "string" || typeof sessionTimeoutMs !== "number") {
    throw new ConfigError(`${CONFIG_FILE} has a baseBranch or sessionTimeoutMs of the wrong type.`);
  }
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ConfigError(`${CONFIG_FILE} has a maxAttempts that is not a whole number of at least 1.`);
  }
  for (const [name, command] of Object.entries({ buildCommand, serveCommand })) {
    if (command !== undefined && (typeof command !== "string" || command.trim() === "")) {
      throw new ConfigError(`${CONFIG_FILE} has a ${name} that is not a command.`);
    }
  }
  if (typeof serveTimeoutMs !== "number") throw new ConfigError(`${CONFIG_FILE} has a serveTimeoutMs of the wrong type.`);
  return {
    testCommand,
    baseBranch,
    sessionTimeoutMs,
    maxAttempts,
    buildCommand: buildCommand as string | undefined,
    serveCommand: serveCommand as string | undefined,
    serveTimeoutMs,
  };
}

/** The Locale packs the Factory has, as a Site names them in `factory.json`: "de" is the German one. */
export const LOCALE_PACKS = ["de"] as const;
export type LocalePack = (typeof LOCALE_PACKS)[number];

/**
 * The Locale pack switched on for the Site, from `localePack` in `factory.json`;
 * none when the Site names none. A `factory.json` that cannot be read has no
 * pack: the Site's own tests check fails on it and says why.
 */
export async function readLocalePack(siteDir: string): Promise<LocalePack | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(siteDir, CONFIG_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const pack = (parsed as { localePack?: unknown } | null)?.localePack;
  if (pack === undefined) return undefined;
  if (typeof pack === "string" && (LOCALE_PACKS as readonly string[]).includes(pack)) return pack as LocalePack;
  throw new ConfigError(`${CONFIG_FILE} names the Locale pack ${JSON.stringify(pack)}, but the Factory has only the German one, "de".`);
}

/** The Agent CLIs the Factory has an adapter for, as a Site names them in `factory.json`. */
export const AGENT_CLIS = ["claude-code", "codex", "antigravity", "gemini"] as const;
export type AgentCliName = (typeof AGENT_CLIS)[number];

/**
 * Which Agent CLI the Site runs its sessions with, from `agentCli` in `factory.json`;
 * Claude Code when the Site names none (or has no `factory.json` yet).
 */
export async function readAgentCliChoice(siteDir: string): Promise<AgentCliName> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(siteDir, CONFIG_FILE), "utf8"));
  } catch {
    return "claude-code";
  }
  const choice = (parsed as { agentCli?: unknown } | null)?.agentCli;
  if (choice === undefined) return "claude-code";
  if (typeof choice === "string" && (AGENT_CLIS as readonly string[]).includes(choice)) return choice as AgentCliName;
  throw new ConfigError(`${CONFIG_FILE} names the Agent CLI ${JSON.stringify(choice)}, but the Factory supports only ${AGENT_CLIS.slice(0, -1).join(", ")} and ${AGENT_CLIS.at(-1)}.`);
}

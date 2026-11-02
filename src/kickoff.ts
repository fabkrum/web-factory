import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_CLIS, CONFIG_FILE, ConfigError, type AgentCliName } from "./config.ts";
import { AGENTS_FILE, commitRecord, fieldReader, findStackSection, hasSectionHeading, kickoffRecorded, readSkillFile, renderAdr, withStackSection, writeAdr, type Choice } from "./decision-record.ts";
import type { Tracker } from "./tracker.ts";

/** What the Builder decided at Kickoff; the kickoff skill writes it down after their conversation. */
export interface KickoffDecisions {
  site: { audience: string; purpose: string; changeFrequency: string };
  /** ISO 3166 two-letter country codes, so that no spelling of a country can leave its Locale pack off. */
  location: { operatorCountry: string; visitorCountries: string[] };
  agentCli: AgentCliName;
  stack: Choice;
  /** `setup` is the chosen host's own setup: required for a host other than Firebase. */
  host: Choice & { setup?: string };
  commands: { test: string; serve: string; build?: string };
}

/** A Kickoff that stopped for a reason the Builder can read; the message is printed as it is. */
export class KickoffError extends Error {}

const STACK_ADR = "docs/adr/0001-stack.md";
const HOST_ADR = "docs/adr/0002-host.md";

const LOCALE_PACK_ON = "The German Locale pack is on: Review checks the Impressum, the privacy policy, price display, and fonts and third-party requests before consent. It catches common mistakes and is not legal advice.";
const LOCALE_PACK_OFF = "No Locale pack is on: Review runs only the generic checks, which check no country's law. This is not legal advice.";

const { text, record, choice } = fieldReader("The Kickoff decisions", (message) => new KickoffError(message));

function country(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z]{2}$/.test(value)) {
    throw new KickoffError(`The Kickoff decisions give ${JSON.stringify(value)} as ${field}; it must be a two-letter country code, such as DE for Germany.`);
  }
  return value;
}

function agentCli(value: unknown): AgentCliName {
  const known = `${AGENT_CLIS.slice(0, -1).join(", ")} and ${AGENT_CLIS.at(-1)}`;
  if (value === undefined) throw new KickoffError(`The Kickoff decisions name no Agent CLI, and there is no default: ask the Builder which one they use (${known}).`);
  if (typeof value === "string" && (AGENT_CLIS as readonly string[]).includes(value)) return value as AgentCliName;
  throw new KickoffError(`The Kickoff decisions name the Agent CLI ${JSON.stringify(value)}, but the Factory supports only ${known}.`);
}

function isFirebase(host: string): boolean {
  return /firebase/i.test(host);
}

/** Checks everything before anything is written, so a refusal changes nothing. */
export function parseDecisions(raw: unknown): KickoffDecisions {
  const decisions = record(raw, "content");
  const site = record(decisions.site, "site");
  const location = record(decisions.location, "location");
  const commands = record(decisions.commands, "commands");
  const host = choice(decisions.host, "host");
  const setup = record(decisions.host, "host").setup;
  if (!isFirebase(host.chosen)) text(setup, `setup of ${host.chosen} (host.setup): the Builder's next step, since the Factory connects only Firebase itself`);
  const { visitorCountries } = location;
  if (!Array.isArray(visitorCountries) || visitorCountries.length === 0) throw new KickoffError("The Kickoff decisions have no location.visitorCountries.");
  if (commands.build !== undefined) text(commands.build, "commands.build");
  const parsed: KickoffDecisions = {
    site: {
      audience: text(site.audience, "site.audience"),
      purpose: text(site.purpose, "site.purpose"),
      changeFrequency: text(site.changeFrequency, "site.changeFrequency"),
    },
    location: {
      operatorCountry: country(location.operatorCountry, "location.operatorCountry"),
      visitorCountries: visitorCountries.map((code) => country(code, "location.visitorCountries")),
    },
    agentCli: agentCli(decisions.agentCli),
    stack: choice(decisions.stack, "stack"),
    host: isFirebase(host.chosen) ? host : { ...host, setup: (setup as string).trim() },
    commands: {
      test: text(commands.test, "commands.test"),
      serve: text(commands.serve, "commands.serve"),
      build: commands.build as string | undefined,
    },
  };
  if (hasSectionHeading(stackBody(parsed))) {
    throw new KickoffError(`The Kickoff decisions hold a line starting with "## " in the text for the Stack section of ${AGENTS_FILE}, where it would start a new section. Write that text without it; host.setup is the likely place.`);
  }
  return parsed;
}

function germanPack({ location }: KickoffDecisions): boolean {
  return location.operatorCountry === "DE" || location.visitorCountries.includes("DE");
}

function nextStep({ host }: KickoffDecisions): string {
  return host.setup ?? "Connect Firebase to the Site's GitHub repository, so that pull requests get a Preview and merging publishes. The kickoff skill walks you through it.";
}

function adr(title: string, decisions: KickoffDecisions, decision: Choice, consequence?: string): string {
  const { site, location } = decisions;
  const context = `The Site is for: ${site.audience}. It must: ${site.purpose}. Its content changes: ${site.changeFrequency}. Its operator is in ${location.operatorCountry}, its Visitors in ${location.visitorCountries.join(", ")}.`;
  return renderAdr(title, context, decision, consequence);
}

/** The body of the Stack section in AGENTS.md, exactly as `findStackSection` reads it back: `parseDecisions` keeps it so. */
function stackBody(decisions: KickoffDecisions): string {
  const { stack, host, agentCli, commands } = decisions;
  return [
    "Decided at Kickoff; the reasons and the options offered are in `docs/adr/`. Build this way. A change to any of it is a new Architecture decision, raised in a Spec.",
    "",
    `- Stack: ${stack.chosen}`,
    `- Host: ${host.chosen}`,
    `- Agent CLI: ${agentCli}`,
    `- Test command: \`${commands.test}\``,
    `- Build command: ${commands.build ? `\`${commands.build}\`` : "none, this Site has no build step"}`,
    `- Serve command: \`${commands.serve}\` (for Review; it listens on \`{port}\` or \`PORT\`)`,
    `- ${germanPack(decisions) ? LOCALE_PACK_ON : LOCALE_PACK_OFF}`,
    "",
    `Next step after Kickoff: ${nextStep(decisions)}`,
  ].join("\n");
}

async function writeRecord(siteDir: string, decisions: KickoffDecisions, agents: string): Promise<void> {
  await writeAdr(siteDir, STACK_ADR, adr(`Build the Site with ${decisions.stack.chosen}`, decisions, decisions.stack));
  const { host } = decisions;
  await writeAdr(siteDir, HOST_ADR, adr(`Host the Site on ${host.chosen}`, decisions, host, `Next step after Kickoff: ${nextStep(decisions)}`));
  await writeFile(join(siteDir, CONFIG_FILE), await configWith(siteDir, decisions));
  await writeFile(join(siteDir, AGENTS_FILE), withStackSection(agents, stackBody(decisions)));
}

/** The Site's `factory.json` with the decisions in it; whatever else it holds stays. */
async function configWith(siteDir: string, decisions: KickoffDecisions): Promise<string> {
  let existing: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await readFile(join(siteDir, CONFIG_FILE), "utf8");
  } catch {
    // A new Site has no factory.json: Kickoff is what writes it.
  }
  if (raw !== undefined) {
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new ConfigError(`${CONFIG_FILE} is not valid JSON.`);
    }
  }
  const { buildCommand: _build, localePack: _pack, ...kept } = existing;
  const { commands } = decisions;
  return `${JSON.stringify(
    {
      ...kept,
      agentCli: decisions.agentCli,
      host: decisions.host.chosen,
      testCommand: commands.test,
      ...(commands.build ? { buildCommand: commands.build } : {}),
      serveCommand: commands.serve,
      ...(germanPack(decisions) ? { localePack: "de" } : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * Records a Kickoff: the ADRs, the settings the Ticket loop and Review read, and the Stack
 * section, then the Stage labels. AGENTS.md is written last, so its Stack section says whether
 * Kickoff is recorded: running again finishes a Kickoff that stopped, and never replaces one.
 */
export async function runKickoff(options: { siteDir: string; file: string; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, file, tracker, stdout } = options;
  const decisions = parseDecisions(await readSkillFile(siteDir, file, "kickoff", (message) => new KickoffError(message)));
  let agents: string;
  try {
    agents = await readFile(join(siteDir, AGENTS_FILE), "utf8");
  } catch {
    throw new KickoffError(`This folder has no ${AGENTS_FILE}, so it is not a Site. Run factory from your Site's folder.`);
  }
  const recorded = findStackSection(agents)?.body;
  if (recorded === undefined || !kickoffRecorded(agents)) {
    await writeRecord(siteDir, decisions, agents);
  } else if (recorded !== stackBody(decisions)) {
    throw new KickoffError(
      `${AGENTS_FILE} already holds this Site's Stack section, and these decisions differ from it, so nothing was changed. A change to the architecture is a new Architecture decision, raised in a Spec.`,
    );
  }
  await commitRecord(siteDir, [AGENTS_FILE, CONFIG_FILE, STACK_ADR, HOST_ADR], "Record the Site's first Architecture decisions");

  try {
    await tracker.ensureStageLabels();
  } catch (error) {
    throw new KickoffError(
      `Your decisions are recorded, but the Stage labels could not be created on GitHub: ${(error as Error).message}\nLog in to GitHub and connect this Site to a repository there, then run this same command again.`,
    );
  }

  stdout(`Kickoff is recorded: ${decisions.stack.chosen} on ${decisions.host.chosen}, with ${decisions.agentCli} as the Agent CLI, and the Stage labels exist on GitHub.\n`);
  stdout(`${germanPack(decisions) ? LOCALE_PACK_ON : LOCALE_PACK_OFF}\n`);
  stdout(`Next step: ${nextStep(decisions)}\n`);
}

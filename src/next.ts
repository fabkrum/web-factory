import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readBoard, type Board, type Card } from "./board.ts";
import type { Clock } from "./clock.ts";
import { AGENTS_FILE, kickoffRecorded } from "./decision-record.ts";
import { PipelineError } from "./request.ts";
import type { Stage } from "./stages.ts";
import type { Tracker } from "./tracker.ts";

export type BuilderSkill = "kickoff" | "request" | "spec" | "design" | "approve";

/** The one thing the Builder does now. */
export interface NextStep {
  action: string;
  /** The skill to use for it; missing when a comment or a command is all it takes. */
  skill?: BuilderSkill;
  /** The Request, Spec or Ticket it is about. */
  issue?: number;
}

const KICKOFF_STEP: NextStep = { action: "Before your first Request, decide how your Site is built: ask your Agent CLI to use the kickoff skill.", skill: "kickoff" };
const NEXT_IDEA = "Describe your next idea or bug in your own words: ask your Agent CLI to use the request skill.";

/** What the Builder can act on, in the order `next` picks it: the work closest to the Visitor first, then the waiting. */
const ORDER = ["approve", "stuck", "start-loop", "design", "spec", "request", "running", "blocked"] as const;
type Kind = (typeof ORDER)[number];

const SKILLS: Partial<Record<Kind, BuilderSkill>> = { approve: "approve", design: "design", spec: "spec", request: "spec" };

function kindOf(stage: Stage, card: Card, specsWithTickets: Set<number | undefined>): Kind | undefined {
  const isTicket = card.spec !== undefined;
  if (stage === "build") {
    if (!isTicket && specsWithTickets.has(card.number)) return undefined;
    switch (card.status) {
      case "parked":
      case "not-passed":
        return "stuck";
      case "blocked":
        return "blocked";
      case "building":
      case "reviewing":
      case "waiting":
        return "running";
      default:
        return "start-loop";
    }
  }
  return (stage === "approve" || stage === "design" || stage === "spec" || stage === "request") && !isTicket ? stage : undefined;
}

/** The one action for a board: the first of `ORDER` that any card asks for, lowest number first. */
export function nextStep(board: Board): NextStep {
  const cards = board.columns.flatMap(({ stage, cards }) => cards.map((card) => ({ stage, card })));
  const specsWithTickets = new Set(cards.map(({ card }) => card.spec));
  const actionable = cards.flatMap(({ stage, card }) => {
    const kind = kindOf(stage, card, specsWithTickets);
    return kind === undefined ? [] : [{ kind, card }];
  });
  for (const kind of ORDER) {
    const [first] = actionable.filter((candidate) => candidate.kind === kind).sort((a, b) => a.card.number - b.card.number);
    if (!first) continue;
    const skill = SKILLS[kind];
    return { action: first.card.nextAction, ...(skill ? { skill } : {}), issue: first.card.number };
  }
  const [stray] = board.withoutStage;
  if (stray) {
    return { action: `#${stray.number} has no Stage, so the Pipeline cannot move it: ask your Agent CLI to use the request skill to file it as a Request, then close #${stray.number}.`, skill: "request", issue: stray.number };
  }
  const automatic = cards.find(({ stage }) => stage === "review" || stage === "publish" || stage === "measure");
  const inProgress = automatic ? `#${automatic.card.number} is in the ${automatic.stage} Stage, which runs by itself. ` : "";
  return { action: `Nothing waits for you. ${inProgress}${NEXT_IDEA}`, skill: "request" };
}

/** Kickoff is read from the Site alone, so `next` works before any GitHub login. */
export async function whatIsNext({ siteDir, tracker, clock }: { siteDir: string; tracker: Tracker; clock: Clock }): Promise<NextStep> {
  let agents: string;
  try {
    agents = await readFile(join(siteDir, AGENTS_FILE), "utf8");
  } catch {
    throw new PipelineError(`This folder has no ${AGENTS_FILE}, so it is not a Site. Run factory from your Site's folder.`);
  }
  if (!kickoffRecorded(agents)) return KICKOFF_STEP;
  return nextStep(await readBoard({ siteDir, tracker, clock }));
}

export function formatNextStep({ action, skill }: NextStep): string {
  return `${action}\n${skill ? `Skill to use: ${skill}` : "No skill needed for this."}\n`;
}

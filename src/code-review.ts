import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Issue } from "./tracker.ts";

/**
 * Where a code review session leaves its report: a file at the root of its directory,
 * which works the same for every Agent CLI, whatever its output looks like.
 */
export const CODE_REVIEW_FILE = ".factory-code-review.json";

export interface CodeReviewPoint {
  text: string;
  /** The name of the Modern Web Guidance this point goes against, when it does. */
  guidance?: string;
}

export interface CodeReview {
  verdict: "approve" | "changes";
  points: CodeReviewPoint[];
}

/** Removes a report left from before the session, so only what the session writes can count. */
export async function clearCodeReview(cwd: string): Promise<void> {
  await rm(join(cwd, CODE_REVIEW_FILE), { force: true });
}

/** The report the session left, removed from the worktree; undefined when there is none or it cannot be read. */
export async function takeCodeReview(cwd: string): Promise<CodeReview | undefined> {
  const path = join(cwd, CODE_REVIEW_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  await rm(path, { force: true });
  try {
    return parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parse(report: unknown): CodeReview | undefined {
  const { verdict, points } = (report ?? {}) as { verdict?: unknown; points?: unknown };
  if ((verdict !== "approve" && verdict !== "changes") || !Array.isArray(points) || !points.every(isPoint)) return undefined;
  // Changes nobody names are nothing a fix round could act on.
  if (verdict === "changes" && points.length === 0) return undefined;
  return { verdict, points };
}

function isPoint(point: unknown): point is CodeReviewPoint {
  const { text, guidance } = (point ?? {}) as { text?: unknown; guidance?: unknown };
  return typeof text === "string" && text.trim() !== "" && (guidance === undefined || typeof guidance === "string");
}

/** The points as one numbered list; the Factory numbers them, so they always are. */
export function numberedPoints(points: CodeReviewPoint[]): string {
  return points.map(({ text, guidance }, i) => `${i + 1}. ${text}${guidance ? ` (Modern Web Guidance: ${guidance})` : ""}`).join("\n");
}

const COMMENT = /^Code review of [0-9a-f]{7}: /;

/** The comment that stores a review's points on the Ticket, naming the commit it read. */
export function codeReviewComment(head: string, { verdict, points }: CodeReview): string {
  const outcome = verdict === "approve" ? "approved, with these points." : "changes needed.";
  return `Code review of ${head.slice(0, 7)}: ${outcome}\n\n${numberedPoints(points)}`;
}

export function isCodeReviewComment(body: string): boolean {
  return COMMENT.test(body);
}

export function codeReviewPrompt(ticket: Issue, base: string): string {
  return [
    `You are the code review of Ticket #${ticket.number}, unattended. Its tests and tool-made Review checks are green; you read what tools cannot judge.`,
    "",
    `# ${ticket.title}`,
    "",
    ticket.body,
    "",
    `The change is \`git diff ${base}...HEAD\`. Read it, and only report on it. Do not edit, commit or fix anything.`,
    "",
    "Check that the change does what the Ticket asks, and that it goes with Modern Web Guidance, the skill in this Site's skills folder: read it first.",
    "When a change goes against Modern Web Guidance, say so in a point and give that guidance's name in the point's `guidance` field.",
    "",
    `Write your report to \`${CODE_REVIEW_FILE}\` in the root of your working directory, without committing it, as JSON:`,
    "",
    '{ "verdict": "approve" or "changes", "points": [{ "text": "one point in plain words", "guidance": "name of the guidance, only when the point goes against one" }] }',
    "",
    'Use "changes" only for something that must be fixed before this Ticket can Pass, and name it in a point. Remarks that need no fix go in the points of an "approve".',
  ].join("\n");
}

import { ABOUTS, type About } from "./about.ts";
import { fieldReader, readSkillFile } from "./decision-record.ts";
import type { Tracker } from "./tracker.ts";

/** A step of the Pipeline refused, for a reason the Builder can read; the message is printed as it is. */
export class PipelineError extends Error {}

const refuse = (message: string) => new PipelineError(message);
const { text, record } = fieldReader("The Request's file and its fields", refuse);

/** Files what the Builder said as a Request. Nothing is filed before the tracker answers, so a refusal loses nothing. */
export async function runRequest(options: { siteDir: string; file: string; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, file, tracker, stdout } = options;
  const request = record(await readSkillFile(siteDir, file, "request", refuse), "content");
  const title = text(request.title, "title");
  const body = text(request.body, "body");
  const about = aboutField(request.about);

  // Also finishes a Kickoff that could not reach GitHub, so the Request gets its proper Stage label.
  await tracker.ensureStageLabels();
  const number = await tracker.createIssue({ title, body, stage: "request", about });

  stdout(`Request #${number} is filed, about ${about === "factory" ? "the Factory's setup in your Site" : "your Site"}: ${title}. Next step: the spec skill questions you about it until it is precise.\n`);
}

/** A Request is about the Site unless the request skill says it is about the Factory's setup. */
function aboutField(value: unknown): About {
  if (value === undefined || value === null) return "site";
  if (typeof value === "string" && (ABOUTS as readonly string[]).includes(value)) return value as About;
  throw refuse(`The Request's file says it is about "${String(value)}"; it can only be about ${ABOUTS.map((about) => `"${about}"`).join(" or ")}.`);
}

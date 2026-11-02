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

  // Also finishes a Kickoff that could not reach GitHub, so the Request gets its proper Stage label.
  await tracker.ensureStageLabels();
  const number = await tracker.createIssue({ title, body, stage: "request" });

  stdout(`Request #${number} is filed: ${title}. Next step: the spec skill questions you about it until it is precise.\n`);
}

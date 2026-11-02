import { fieldReader, readSkillFile } from "./decision-record.ts";
import { PipelineError } from "./request.ts";
import { inStage, ticketBody } from "./spec.ts";
import { integrationBranch, previewIn } from "./ticket-loop.ts";
import type { Tracker } from "./tracker.ts";

const refuse = (message: string) => new PipelineError(message);
const { text, record } = fieldReader("The change's file and its fields", refuse);

/** Refuses anything but an open Spec in the Approve Stage. */
async function specInApprove(spec: number, tracker: Tracker): Promise<void> {
  const issue = await tracker.getIssue(spec);
  if (issue.state === "closed" || !inStage(issue, "approve")) {
    throw refuse(`#${spec} is not a Spec waiting in the Approve Stage, so there is nothing to approve. To see where your work stands, run: factory next`);
  }
}

/**
 * Approve itself is the Builder's merge on GitHub, which no session makes for them: while the
 * pull request is open this says where to read and merge, and once it is merged, whoever
 * started it, the Spec moves on. Running it again changes nothing more.
 */
export async function runApprove(options: { spec: number; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { spec, tracker, stdout } = options;
  if (inStage(await tracker.getIssue(spec), "publish")) {
    stdout(`Spec #${spec} is already approved and in the Publish Stage.\n`);
    return;
  }
  await specInApprove(spec, tracker);
  const head = integrationBranch(spec);
  const open = await tracker.pullRequestFrom(head);
  if (open) {
    const preview = previewIn(open.body);
    stdout(`Spec #${spec} waits for you and pull request #${open.number} is not merged yet.\n`);
    stdout(preview ? `Read the Preview: ${preview}\n` : `The pull request names no Preview, so look for it there.\n`);
    stdout(`When the Site does what the Spec says, merge the pull request: ${open.url}\nThen run this same command again.\n`);
    return;
  }
  if (!(await tracker.mergedPullRequestFrom(head))) {
    throw refuse(`Spec #${spec} has no pull request, open or merged. Run the Ticket loop, which opens a new one: factory loop ${spec}`);
  }
  await tracker.moveToStage(spec, "publish");
  stdout(`Spec #${spec} is approved: its pull request is merged and the Spec is in the Publish Stage.\n`);
}

/** Files what the Builder wants changed as a new Ticket. Running it again after a stop files no second Ticket. */
export async function approveChange(options: { siteDir: string; spec: number; file: string; tracker: Tracker; stdout: (text: string) => void }): Promise<void> {
  const { siteDir, spec, file, tracker, stdout } = options;
  const change = record(await readSkillFile(siteDir, file, "approve", refuse), "content");
  const title = text(change.title, "title");
  const delivers = text(change.delivers, "delivers");
  if (!Array.isArray(change.acceptance) || change.acceptance.length === 0) throw refuse("The change's file and its fields have no acceptance.");
  const acceptance = change.acceptance.map((entry, index) => text(entry, `acceptance[${index}]`));

  // An earlier change moved the Spec to Build; with its pull request still open, it takes this one too.
  const issue = await tracker.getIssue(spec);
  const open = await tracker.pullRequestFrom(integrationBranch(spec));
  if (!open || issue.state === "closed" || !inStage(issue, "build")) await specInApprove(spec, tracker);
  if (!open) {
    throw refuse(`Spec #${spec} has no open pull request for this change to join. If it is merged, run factory approve ${spec}, and bring the change as a new Request.`);
  }
  // The Ticket first, so a run GitHub cuts short leaves the Spec in Approve, and running again finishes it.
  const tickets = await tracker.ticketsOf(spec);
  const ticket = tickets.find((candidate) => candidate.state === "open" && candidate.title === title)?.number
    ?? (await tracker.createIssue({ title, body: ticketBody({ delivers, acceptance }, spec), stage: "build", parent: spec }));
  await tracker.moveToStage(spec, "build");
  stdout(`Ticket #${ticket} is in the Build Stage: ${title}. The pull request stays open and gets this change too. Start the Ticket loop with: factory loop ${spec}\n`);
}

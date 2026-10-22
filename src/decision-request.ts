import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { git, gitSucceeds } from "./git.ts";

/**
 * Where a session leaves a question only the Builder can answer: a file at the root of
 * its directory. A file works the same for every Agent CLI, whatever its output looks like.
 */
export const DECISION_FILE = ".factory-decision.md";

/** What every adapter tells its session about asking for a decision. */
export const DECISION_RULES = [
  "You run unattended: nobody reads or answers you while you work. Never ask a question in your reply.",
  `Only when the work needs a decision that only the Builder can make, write that question in plain words to \`${DECISION_FILE}\``,
  "in the root of your working directory (what you need decided, the options, your recommendation),",
  "do not commit that file, and stop. Decide everything else yourself.",
].join(" ");

/**
 * The question the session left, if it left one. The file is removed so the Ticket's
 * worktree is clean again; a session that committed it anyway gets a commit taking it out.
 */
export async function takeDecisionRequest(cwd: string): Promise<string | undefined> {
  let question: string;
  try {
    question = (await readFile(join(cwd, DECISION_FILE), "utf8")).trim();
  } catch {
    return undefined;
  }
  if (await gitSucceeds(cwd, "ls-files", "--error-unmatch", DECISION_FILE)) {
    await git(cwd, "rm", "-q", DECISION_FILE);
    await git(cwd, "commit", "-q", "-m", "chore: the decision request goes to the Ticket, not the Site");
  } else {
    await rm(join(cwd, DECISION_FILE), { force: true });
  }
  return question === "" ? "The session asked for a decision without saying what it is." : question;
}

import { access } from "node:fs/promises";
import { join } from "node:path";
import { DESIGN_FILE, handoffFailures, HANDOFF_FOLDER } from "../design-handoff.ts";
import { git } from "../git.ts";
import type { ReviewCheck } from "./check.ts";

/** Whether this repository's history ever held a Design handoff; outside git there is no telling. */
function everHadHandoff(repo: string): Promise<boolean> {
  return git(repo, "log", "-1", "--format=%h", "--", DESIGN_FILE).then((commit) => commit.trim() !== "", () => false);
}

export const designCheck: ReviewCheck = {
  id: "code/design",
  name: "DESIGN.md passes its lint and contrast check, and the tokens still match it",
  area: "Code & security",
  needsRepo: true,
  async run(site) {
    const repo = site.repo!;
    const there = await access(join(repo, DESIGN_FILE)).then(() => true, () => false);
    if (!there && !(await everHadHandoff(repo))) {
      return { notRun: `Not run: this Site has no Design handoff yet, so there is no ${HANDOFF_FOLDER}/DESIGN.md to check. The Design Stage makes it.` };
    }
    return handoffFailures(repo);
  },
};

import { describe, expect, it } from "vitest";
import { STAGES, stageLabel } from "../../src/stages.ts";
import type { Tracker } from "../../src/tracker.ts";

/** A tracker under contract, plus what a Builder or GitHub itself does around it. */
export interface ContractSubject {
  tracker: Tracker;
  /** Pushes a branch with a commit of its own to the Site's remote; returns the base it can merge into. */
  pushBranch(name: string): Promise<string>;
  /** The Builder reopens an issue by hand. */
  reopenByHand(issue: number): Promise<void>;
  createLabel(name: string): Promise<void>;
  /** Deletes a label from the repository, if it has it. */
  deleteLabel(name: string): Promise<void>;
}

/**
 * The behaviour every tracker shares, so the fake the loop's tests use and the real GitHub
 * adapter cannot drift apart. With `skip`, the whole contract is skipped and the reason
 * shows in the test report.
 */
export function trackerContract(
  name: string,
  subject: () => Promise<ContractSubject>,
  options: { skip?: string; timeout?: number } = {},
): void {
  const title = options.skip ? `${name} (skipped: ${options.skip})` : name;
  // Titles carry a run id, so a real repository that keeps old runs' issues still tells them apart.
  const run = `${Date.now().toString(36)}`;

  describe.skipIf(options.skip !== undefined)(title, { timeout: options.timeout }, () => {
    it("files a Spec with its Tickets as sub-issues, each in its Stage", async () => {
      const { tracker } = await subject();
      const spec = await tracker.createIssue({ title: `Spec ${run}`, body: "A greeting page.", stage: "spec" });
      const first = await tracker.createIssue({ title: `Ticket A ${run}`, body: "Say hello.", stage: "build", parent: spec });
      const second = await tracker.createIssue({ title: `Ticket B ${run}`, body: "", stage: "build", parent: spec });
      const otherSpec = await tracker.createIssue({ title: `Other Spec ${run}`, body: "", stage: "spec" });
      await tracker.createIssue({ title: `Other Ticket ${run}`, body: "", stage: "build", parent: otherSpec });

      const tickets = (await tracker.ticketsOf(spec)).sort((a, b) => a.number - b.number);
      expect(tickets).toEqual([
        { number: first, title: `Ticket A ${run}`, body: "Say hello.", state: "open", labels: ["stage:build"], blockedBy: [] },
        { number: second, title: `Ticket B ${run}`, body: "", state: "open", labels: ["stage:build"], blockedBy: [] },
      ]);
      expect(await tracker.getIssue(spec)).toMatchObject({ number: spec, title: `Spec ${run}`, state: "open", labels: ["stage:spec"] });
    });

    it("rewrites an issue when a Request becomes its Spec, and it stays the same issue", async () => {
      const { tracker } = await subject();
      const request = await tracker.createIssue({ title: `Request ${run}`, body: "My words.", stage: "request" });

      await tracker.updateIssue(request, { title: `Spec ${run}`, body: "Worked out." });

      expect(await tracker.getIssue(request)).toMatchObject({ number: request, title: `Spec ${run}`, body: "Worked out.", state: "open", labels: ["stage:request"] });
    });

    it("takes a dropped Ticket out of its Spec and closes it", async () => {
      const { tracker } = await subject();
      const spec = await tracker.createIssue({ title: `Spec ${run}`, body: "", stage: "spec" });
      const kept = await tracker.createIssue({ title: `Kept ${run}`, body: "", stage: "spec", parent: spec });
      const dropped = await tracker.createIssue({ title: `Dropped ${run}`, body: "", stage: "spec", parent: spec });

      await tracker.removeTicket(spec, dropped);

      expect((await tracker.ticketsOf(spec)).map((ticket) => ticket.number)).toEqual([kept]);
      expect((await tracker.getIssue(dropped)).state).toBe("closed");
    });

    it("records blockers and shows them on the blocked Ticket", async () => {
      const { tracker } = await subject();
      const spec = await tracker.createIssue({ title: `Spec ${run}`, body: "", stage: "spec" });
      const first = await tracker.createIssue({ title: `First ${run}`, body: "", stage: "build", parent: spec });
      const second = await tracker.createIssue({ title: `Second ${run}`, body: "", stage: "build", parent: spec });
      const outside = await tracker.createIssue({ title: `Outside ${run}`, body: "", stage: "request" });

      await tracker.addBlocker(second, first);
      await tracker.addBlocker(second, outside);

      expect((await tracker.getIssue(second)).blockedBy.sort((a, b) => a - b)).toEqual([first, outside]);
      expect((await tracker.getIssue(first)).blockedBy).toEqual([]);
      const fromSpec = (await tracker.ticketsOf(spec)).find((ticket) => ticket.number === second);
      expect(fromSpec?.blockedBy.sort((a, b) => a - b)).toEqual([first, outside]);
    });

    it("keeps exactly one Stage label as an issue moves through the Pipeline", async () => {
      const { tracker } = await subject();
      const request = await tracker.createIssue({ title: `Request ${run}`, body: "", stage: "request" });

      await tracker.moveToStage(request, "spec");
      await tracker.moveToStage(request, "design");

      expect((await tracker.getIssue(request)).labels).toEqual(["stage:design"]);
    });

    it("tells comments, closes and reopens apart, oldest first", async () => {
      const { tracker, reopenByHand } = await subject();
      const ticket = await tracker.createIssue({ title: `Ticket ${run}`, body: "", stage: "build" });

      await tracker.comment(ticket, "Attempt 1 failed: the tests are red.");
      await tracker.close(ticket);
      await reopenByHand(ticket);
      await tracker.comment(ticket, "Attempt 2 passed.");

      expect(await tracker.historyOf(ticket)).toEqual([
        { kind: "comment", body: "Attempt 1 failed: the tests are red." },
        { kind: "closed" },
        { kind: "reopened" },
        { kind: "comment", body: "Attempt 2 passed." },
      ]);
      expect((await tracker.getIssue(ticket)).state).toBe("open");
      await tracker.close(ticket);
      expect((await tracker.getIssue(ticket)).state).toBe("closed");
    });

    it("creates the missing Stage labels and never duplicates one", async () => {
      const { tracker, deleteLabel } = await subject();
      await tracker.ensureStageLabels();
      await deleteLabel("stage:measure");

      expect(await tracker.ensureStageLabels()).toEqual(["stage:measure"]);
      expect(await tracker.ensureStageLabels()).toEqual([]);
      const labels = await tracker.labels();
      for (const stage of STAGES) expect(labels.filter((label) => label === stageLabel(stage))).toHaveLength(1);
    });

    it("counts a Stage label written in other letter case as existing", async () => {
      const { tracker, createLabel, deleteLabel } = await subject();
      await tracker.ensureStageLabels();
      await deleteLabel("stage:review");
      await createLabel("Stage:Review");

      expect(await tracker.ensureStageLabels()).toEqual([]);
      expect((await tracker.labels()).filter((label) => label.toLowerCase() === "stage:review")).toEqual(["Stage:Review"]);

      await deleteLabel("Stage:Review");
      expect(await tracker.ensureStageLabels()).toEqual(["stage:review"]);
    });

    it("opens a pull request from a pushed branch and finds it again", async () => {
      const { tracker, pushBranch } = await subject();
      const head = `loop/spec-${run}`;
      expect(await tracker.pullRequestFrom(head)).toBeUndefined();
      const base = await pushBranch(head);

      const opened = await tracker.openPullRequest({ head, base, title: `Spec ${run}`, body: "Read its Preview first." });

      expect(opened.url).toMatch(new RegExp(`/pull/${opened.number}$`));
      expect(await tracker.pullRequestFrom(head)).toEqual(opened);
      expect(await tracker.pullRequestFrom(`loop/never-pushed-${run}`)).toBeUndefined();
    });

    it("lists the open issues with each Ticket's Spec, without closed ones or pull requests", async () => {
      const { tracker, pushBranch } = await subject();
      const spec = await tracker.createIssue({ title: `Listed Spec ${run}`, body: "", stage: "build" });
      const ticket = await tracker.createIssue({ title: `Listed Ticket ${run}`, body: "", stage: "build", parent: spec });
      const closed = await tracker.createIssue({ title: `Listed closed ${run}`, body: "", stage: "request" });
      const later = await tracker.createIssue({ title: `Listed later ${run}`, body: "", stage: "request" });
      await tracker.close(closed);
      const head = `loop/listed-${run}`;
      const base = await pushBranch(head);
      const pull = await tracker.openPullRequest({ head, base, title: `Listed pull ${run}`, body: "" });

      const open = await tracker.openIssues();
      const numbers = open.map((issue) => issue.number);

      expect(numbers).toEqual(expect.arrayContaining([spec, ticket, later]));
      expect(numbers).not.toContain(closed);
      expect(numbers).not.toContain(pull.number);
      expect(open.find((issue) => issue.number === ticket)).toMatchObject({ title: `Listed Ticket ${run}`, labels: ["stage:build"], parent: spec, url: expect.stringMatching(new RegExp(`/issues/${ticket}$`)) });
      expect(open.find((issue) => issue.number === spec)?.parent).toBeUndefined();
    });

    it("refuses an issue it does not have", async () => {
      const { tracker } = await subject();
      await expect(tracker.getIssue(987_654_321)).rejects.toThrow();
    });
  });
}

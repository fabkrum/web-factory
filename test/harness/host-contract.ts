import { describe, expect, it } from "vitest";
import type { Host } from "../../src/host.ts";
import { commitFile, createSiteRepo, git } from "./site-repo.ts";

/** A host adapter under contract, plus what a Visitor sees. */
export interface HostSubject {
  host: Host;
  /** Commits in the Site whatever this host needs from the Builder's side of its setup. */
  prepareSite(dir: string): void;
  /** What a Visitor reads at a URL the host gave. */
  read(url: string): Promise<string>;
}

/**
 * The behaviour every host shares, as the Ticket loop and Publish see it: a Preview per branch
 * that leaves the live Site alone, and a Publish. With `skip`, the whole contract is skipped
 * and the reason shows in the test report.
 */
export function hostContract(name: string, subject: () => Promise<HostSubject>, options: { skip?: string; timeout?: number } = {}): void {
  const title = options.skip ? `${name} (skipped: ${options.skip})` : name;
  // Pages carry a run id, so a real host that keeps the last run's pages still tells them apart.
  const run = Date.now().toString(36);

  const site = async () => {
    const parts = await subject();
    const dir = createSiteRepo({ testCommand: "true" });
    parts.prepareSite(dir);
    commitFile(dir, "index.html", `<h1>main ${run}</h1>\n`);
    return { ...parts, dir };
  };
  const branch = (dir: string, name: string, page: string) => {
    git(dir, "checkout", "-q", "-b", name);
    commitFile(dir, "index.html", page);
    git(dir, "checkout", "-q", "main");
  };

  describe.skipIf(options.skip !== undefined)(title, { timeout: options.timeout }, () => {
    it("gives a branch a Preview URL that serves that branch, from a Site on another branch", async () => {
      const { host, read, dir } = await site();
      branch(dir, "spec/1", `<h1>spec one ${run}</h1>\n`);

      const url = await host.deployPreview({ siteDir: dir, branch: "spec/1" });

      expect(url).toMatch(/^https:\/\//);
      expect(await read(url)).toContain(`spec one ${run}`);
    });

    it("gives two branches two Previews", async () => {
      const { host, dir } = await site();
      branch(dir, "spec/1", `<h1>one ${run}</h1>\n`);
      branch(dir, "spec/2", `<h1>two ${run}</h1>\n`);

      const first = await host.deployPreview({ siteDir: dir, branch: "spec/1" });
      const second = await host.deployPreview({ siteDir: dir, branch: "spec/2" });

      expect(first).not.toBe(second);
    });

    it("replaces a branch's Preview at the same URL when it is deployed again", async () => {
      const { host, read, dir } = await site();
      branch(dir, "spec/1", `<h1>first ${run}</h1>\n`);
      const url = await host.deployPreview({ siteDir: dir, branch: "spec/1" });
      git(dir, "checkout", "-q", "spec/1");
      commitFile(dir, "index.html", `<h1>second ${run}</h1>\n`);
      git(dir, "checkout", "-q", "main");

      expect(await host.deployPreview({ siteDir: dir, branch: "spec/1" })).toBe(url);
      expect(await read(url)).toContain(`second ${run}`);
    });

    it("publishes the Site live, and a later Preview leaves the live Site alone", async () => {
      const { host, read, dir } = await site();

      const live = await host.publishLive({ siteDir: dir });
      branch(dir, "spec/1", `<h1>not live ${run}</h1>\n`);
      const preview = await host.deployPreview({ siteDir: dir, branch: "spec/1" });

      expect(live).toMatch(/^https:\/\//);
      expect(preview).not.toBe(live);
      expect(await read(live)).toContain(`main ${run}`);
    });

    it("leaves the Site repository as it was", async () => {
      const { host, dir } = await site();
      branch(dir, "spec/1", `<h1>one ${run}</h1>\n`);
      const worktrees = git(dir, "worktree", "list");

      await host.deployPreview({ siteDir: dir, branch: "spec/1" });

      expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expect(git(dir, "branch", "--show-current")).toBe("main");
      expect(git(dir, "worktree", "list")).toBe(worktrees);
    });

    it("connects a Site, and connecting it again changes nothing", async () => {
      const { host, dir } = await site();

      await host.connect({ siteDir: dir, baseBranch: "main" });
      const once = git(dir, "status", "--porcelain");
      await host.connect({ siteDir: dir, baseBranch: "main" });

      expect(git(dir, "status", "--porcelain")).toBe(once);
    });
  });
}

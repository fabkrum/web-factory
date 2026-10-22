import type { Host } from "../../src/host.ts";

/** A host that returns a Preview URL for each branch it is asked to deploy. */
export class FakeHost implements Host {
  readonly previews: { siteDir: string; branch: string; url: string }[] = [];

  async deployPreview({ siteDir, branch }: { siteDir: string; branch: string }): Promise<string> {
    const url = `https://preview.example.test/${branch.replaceAll("/", "-")}`;
    this.previews.push({ siteDir, branch, url });
    return url;
  }
}

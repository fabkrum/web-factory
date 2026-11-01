import { execFileSync } from "node:child_process";
import { HostError, type Host } from "../../src/host.ts";

/** What the page at the Site's root says in a commit, if it has one. */
function pageIn(siteDir: string, commit: string): string {
  try {
    return execFileSync("git", ["show", `${commit}:index.html`], { cwd: siteDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** A host that returns a Preview URL for each branch it is asked to deploy, and remembers what each URL serves. */
export class FakeHost implements Host {
  static readonly LIVE_URL = "https://live.example.test/";
  readonly previews: { siteDir: string; branch: string; url: string }[] = [];
  readonly connected: { siteDir: string; baseBranch: string }[] = [];
  readonly published: { siteDir: string; url: string }[] = [];
  readonly #served = new Map<string, string>();

  async connect(site: { siteDir: string; baseBranch: string }): Promise<void> {
    this.connected.push(site);
  }

  async deployPreview({ siteDir, branch }: { siteDir: string; branch: string }): Promise<string> {
    const url = `https://preview.example.test/${branch.replaceAll("/", "-")}`;
    this.previews.push({ siteDir, branch, url });
    this.#served.set(url, pageIn(siteDir, branch));
    return url;
  }

  async publishLive({ siteDir }: { siteDir: string }): Promise<string> {
    const url = FakeHost.LIVE_URL;
    this.published.push({ siteDir, url });
    this.#served.set(url, pageIn(siteDir, "HEAD"));
    return url;
  }

  /** What a Visitor sees at a URL this host serves. */
  async read(url: string): Promise<string> {
    const page = this.#served.get(url);
    if (page === undefined) throw new HostError(`Nothing is served at ${url}.`);
    return page;
  }
}

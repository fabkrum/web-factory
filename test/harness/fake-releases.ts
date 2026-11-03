import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactoryReleases, Release, ReleaseFacts } from "../../src/releases.ts";

export interface FakeRelease extends Partial<ReleaseFacts> {
  /** The Site's first files in this release, by path; `gitignore` stands for `.gitignore`, as in the starter. */
  template?: Record<string, string>;
}

/** What npm would answer for the Factory's published releases, offline. */
export class FakeReleases implements FactoryReleases {
  /** Set to make every answer fail, as an unreachable registry does. */
  unreachable = false;
  readonly #releases: Record<string, FakeRelease>;
  readonly #latest: string;

  constructor(latest: string, releases: Record<string, FakeRelease>) {
    this.#latest = latest;
    this.#releases = releases;
  }

  async latest(): Promise<string> {
    if (this.unreachable) throw new Error("npm cannot be reached");
    return this.#latest;
  }

  async fetch(version: string, into: string): Promise<Release> {
    const release = this.#releases[version];
    if (!release) throw new Error(`no release ${version}`);
    const template = join(into, "template");
    mkdirSync(template, { recursive: true });
    for (const [path, content] of Object.entries(release.template ?? {})) {
      mkdirSync(dirname(join(template, path)), { recursive: true });
      writeFileSync(join(template, path), content);
    }
    return { designFormat: "alpha", modernWebGuidance: "0.0.196", reviewChecks: [], ...release, template };
  }

  async pin(siteDir: string, version: string): Promise<void> {
    const manifest = JSON.parse(readFileSync(join(siteDir, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    manifest.devDependencies["@fabkrum/web-factory"] = version;
    writeFileSync(join(siteDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(siteDir, "package-lock.json"), `{"factory":"${version}"}\n`);
  }
}

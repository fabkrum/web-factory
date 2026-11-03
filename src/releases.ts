import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FACTORY_PACKAGE } from "./pins.ts";
import { PipelineError } from "./request.ts";

/** The starter is released at the Factory's version and carries the Site's first files. */
const STARTER_PACKAGE = "create-web-factory";

/** What one release of the Factory pins, read from the starter's `release.json`. */
export interface ReleaseFacts {
  designFormat: string;
  modernWebGuidance: string;
  reviewChecks: string[];
}

export interface Release extends ReleaseFacts {
  /** The folder holding the Site's first files in this release. */
  template: string;
}

/** The boundary to where the Factory is published (npm). */
export interface FactoryReleases {
  latest(): Promise<string>;
  /** Unpacks a release into the folder `into`. */
  fetch(version: string, into: string): Promise<Release>;
  /** Moves the Factory's exact pin in `siteDir`'s package.json and lockfile, installing nothing. */
  pin(siteDir: string, version: string): Promise<void>;
}

/** The releases on npm, through the Builder's own `npm`. */
export class NpmReleases implements FactoryReleases {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv | undefined;

  constructor(options: { cwd: string; env?: NodeJS.ProcessEnv }) {
    this.#cwd = options.cwd;
    this.#env = options.env;
  }

  async latest(): Promise<string> {
    return (await this.#run("view", this.#cwd, [FACTORY_PACKAGE, "version"])).trim();
  }

  async fetch(version: string, into: string): Promise<Release> {
    const packed = (await this.#run("pack", this.#cwd, [`${STARTER_PACKAGE}@${version}`, "--pack-destination", into, "--silent"])).trim().split("\n").at(-1)!;
    await command("tar", ["-xzf", join(into, packed), "-C", into], { cwd: into, env: this.#env });
    const facts = JSON.parse(await readFile(join(into, "package", "release.json"), "utf8")) as ReleaseFacts;
    return { ...facts, template: join(into, "package", "template") };
  }

  async pin(siteDir: string, version: string): Promise<void> {
    await this.#run("install", siteDir, [`${FACTORY_PACKAGE}@${version}`, "--package-lock-only", "--save-dev", "--save-exact", "--no-audit", "--no-fund"]);
  }

  async #run(verb: string, cwd: string, args: string[]): Promise<string> {
    try {
      return await command("npm", [verb, ...args], { cwd, env: this.#env });
    } catch (error) {
      const reason = (error as Error).message.split("\n").slice(-3).join("\n");
      throw new PipelineError(`npm could not fetch the Factory's releases, often because of the network, so nothing was changed. Run this same command again.\n${reason}`);
    }
  }
}

function command(name: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv | undefined }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${name} failed with exit code ${code}`))));
  });
}

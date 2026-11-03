import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "repos");

export interface FixtureRepo {
  dir: string;
  remove: () => Promise<void>;
}

/**
 * Copies the Site repository test/fixtures/repos/<name> into a throwaway folder,
 * with an .npmrc that points npm at the given registry (the fake one) and at a
 * cache of its own, as a Site's own .npmrc would.
 */
export async function copyFixtureRepo(name: string, registry: string): Promise<FixtureRepo> {
  const dir = await mkdtemp(join(tmpdir(), `web-factory-repo-${name}-`));
  await cp(join(FIXTURES, name), dir, { recursive: true });
  await writeFile(join(dir, ".npmrc"), `registry=${registry}\ncache=${join(dir, ".npm-cache")}\nupdate-notifier=false\n`);
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

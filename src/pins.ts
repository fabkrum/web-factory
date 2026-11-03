import { git } from "./git.ts";

/** The Factory package a Site depends on, at one exact version. */
export const FACTORY_PACKAGE = "@fabkrum/web-factory";

/** The vendored Modern Web Guidance; its files are its pin. */
export const GUIDANCE_FOLDER = ".agents/skills/modern-web-guidance";

/**
 * The Factory version a package.json pins. The DESIGN.md format version and every Review
 * check live in the Factory, so this one pin moves them too.
 */
export function factoryPin(manifest: string | undefined): string | undefined {
  try {
    const { devDependencies, dependencies } = JSON.parse(manifest ?? "") as Record<string, Record<string, string> | undefined>;
    return devDependencies?.[FACTORY_PACKAGE] ?? dependencies?.[FACTORY_PACKAGE];
  } catch {
    return undefined;
  }
}

/** The Factory version pinned at a commit, if that commit has one. */
export async function factoryPinAt(cwd: string, commit: string): Promise<string | undefined> {
  return factoryPin(await git(cwd, "show", `${commit}:package.json`).catch(() => undefined));
}

/** Which pinned versions differ between two commits, by name. */
export async function movedPins(cwd: string, from: string, to: string): Promise<string[]> {
  const moved: string[] = [];
  if ((await factoryPinAt(cwd, from)) !== (await factoryPinAt(cwd, to))) moved.push("the Factory version in package.json");
  if ((await git(cwd, "diff", "--name-only", from, to, "--", GUIDANCE_FOLDER)) !== "") moved.push("the Modern Web Guidance files");
  return moved;
}

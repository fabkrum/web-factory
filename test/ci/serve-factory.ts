// Serves this checkout's two packages as if they were published, for the installer's CI job.
// Everything else goes to the real npm registry. Prints the registry's address and keeps running.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveFakePackageRegistry } from "../harness/fake-package-registry.ts";

const repository = resolve(import.meta.dirname, "..", "..");

function pack(directory: string): string {
  const into = mkdtempSync(join(tmpdir(), "web-factory-pack-"));
  execFileSync("npm", ["pack", "--pack-destination", into], { cwd: directory, stdio: ["ignore", "ignore", "inherit"] });
  return join(into, readdirSync(into)[0] as string);
}

const packages = [{ tarball: pack(repository) }, { tarball: pack(join(repository, "packages", "create-web-factory")) }];
const registry = await serveFakePackageRegistry(packages, { fallback: "https://registry.npmjs.org" });
console.log(registry.url);

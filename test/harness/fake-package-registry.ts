import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface PublishedPackage {
  /** A tarball made by `npm pack`. */
  tarball: string;
  /** Leaves the package's dependencies out of what the registry says, so nothing else needs serving. */
  withoutDependencies?: boolean;
}

export interface FakePackageRegistry {
  url: string;
  close: () => Promise<void>;
}

/**
 * A local stand-in for the npm registry, serving packed packages as their only version, tagged
 * latest. Anything else is a 404, or is sent on to `fallback` when there is one.
 */
export async function serveFakePackageRegistry(packages: PublishedPackage[], options: { fallback?: string } = {}): Promise<FakePackageRegistry> {
  const documents = new Map<string, unknown>();
  const tarballs = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname);
    const tarball = tarballs.get(path);
    const document = documents.get(path);
    if (tarball) response.end(tarball);
    else if (document) response.setHeader("content-type", "application/json").end(JSON.stringify(document));
    else if (options.fallback) response.writeHead(302, { location: `${options.fallback}${request.url}` }).end();
    else response.writeHead(404).end("{}");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const { tarball, withoutDependencies } of packages) {
    const content = readFileSync(tarball);
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })) as { name: string; version: string };
    const file = `/${manifest.name}/-/package-${manifest.version}.tgz`;
    tarballs.set(file, content);
    documents.set(`/${manifest.name}`, {
      name: manifest.name,
      "dist-tags": { latest: manifest.version },
      versions: {
        [manifest.version]: {
          ...manifest,
          ...(withoutDependencies ? { dependencies: {} } : {}),
          dist: { tarball: `${url}${file}`, shasum: createHash("sha1").update(content).digest("hex") },
        },
      },
    });
  }
  return { url, close: () => new Promise((closed) => server.close(() => closed())) };
}

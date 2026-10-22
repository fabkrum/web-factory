import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

/** One security advisory the fake registry knows, in the shape npm's bulk advisory endpoint answers. */
export interface Advisory {
  package: string;
  title: string;
  url: string;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  vulnerableVersions: string;
}

export interface FakeNpmRegistry {
  url: string;
  close: () => Promise<void>;
}

/**
 * A local stand-in for the npm registry, so the real `npm audit` runs offline
 * and always finds the same advisories. It answers the bulk advisory endpoint
 * npm audit posts the lockfile's packages to, and each package's version list,
 * which npm reads to tell whether a fix exists.
 */
export async function serveFakeNpmRegistry(
  advisories: Advisory[],
  versions: Record<string, string[]> = {},
): Promise<FakeNpmRegistry> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname);
      if (request.method === "POST" && path === "/-/npm/v1/security/advisories/bulk") {
        const raw = Buffer.concat(chunks);
        const asked = JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString() || "{}") as Record<string, string[]>;
        const answer: Record<string, unknown[]> = {};
        advisories.forEach((advisory, i) => {
          if (!(advisory.package in asked)) return;
          (answer[advisory.package] ??= []).push({
            id: 1000 + i,
            url: advisory.url,
            title: advisory.title,
            severity: advisory.severity,
            vulnerable_versions: advisory.vulnerableVersions,
            cwe: [],
            cvss: { score: 0, vectorString: null },
          });
        });
        return json(answer);
      }
      const name = path.slice(1);
      if (request.method === "GET" && versions[name]) {
        const list = versions[name]!;
        return json({
          name,
          "dist-tags": { latest: list.at(-1) },
          versions: Object.fromEntries(list.map((version) => [version, { name, version }])),
        });
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });

    function json(body: unknown): void {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

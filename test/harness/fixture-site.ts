import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "sites");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServedSite {
  url: string;
  close: () => Promise<void>;
}

/** Serves one fixture Site from test/fixtures/sites/<name> on a free local port. */
export async function serveFixtureSite(name: string): Promise<ServedSite> {
  const root = join(FIXTURES, name);
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://fixture").pathname);
    const relative = normalize(path.endsWith("/") ? `${path}index.html` : path);
    try {
      const body = await readFile(join(root, relative));
      response.writeHead(200, { "content-type": TYPES[extname(relative)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

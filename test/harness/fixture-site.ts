import { readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
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

/**
 * The security headers a well-set-up host sends with every answer, so every
 * fixture passes the security headers check. The policy allows inline scripts
 * and styles because the fixtures carry theirs inline. A fixture overrides them
 * with a headers.json of its own; null leaves a header out.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

export interface ServedSite {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves one fixture Site from test/fixtures/sites/<name> on a free local port,
 * the way a well-set-up static host does: a folder's index.html answers at the
 * folder's address with a trailing slash, and the other forms of that address
 * redirect there, so every page has one URL unless a fixture copies it. Every
 * answer carries the security headers, unless the fixture's headers.json says
 * otherwise.
 */
export async function serveFixtureSite(name: string): Promise<ServedSite> {
  const root = join(FIXTURES, name);
  const overrides = await readFile(join(root, "headers.json"), "utf8").then((text) => JSON.parse(text) as Record<string, string | null>, () => ({}));
  const headers = Object.fromEntries(
    Object.entries({ ...SECURITY_HEADERS, ...overrides }).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  const server = createServer(async (request, response) => {
    for (const [header, value] of Object.entries(headers)) response.setHeader(header, value);
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://fixture").pathname);
    if (path.endsWith("/index.html")) return redirect(response, path.slice(0, -"index.html".length));
    if (!path.endsWith("/") && (await isFolder(join(root, normalize(path))))) return redirect(response, `${path}/`);
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

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(301, { location });
  response.end();
}

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isDirectory(), () => false);
}

// Serves this Site the way a well-set-up static host does, on the port in PORT.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8" };
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

createServer(async (request, response) => {
  for (const [header, value] of Object.entries(HEADERS)) response.setHeader(header, value);
  const path = new URL(request.url ?? "/", "http://site").pathname;
  if (path.endsWith("/index.html")) {
    response.writeHead(301, { location: path.slice(0, -"index.html".length) });
    return response.end();
  }
  const file = normalize(path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(join(import.meta.dirname, file));
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(process.env.PORT);

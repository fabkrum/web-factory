import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServedSite } from "./fixture-site.ts";

/** What one path answers: an HTML page, a full response, or a handler for anything else. */
export type Answer =
  | string
  | { status?: number; headers?: Record<string, string>; body?: string }
  | ((request: IncomingMessage, response: ServerResponse) => void);

/**
 * Serves a Site made of the given paths on a free local port, for the cases a
 * static fixture folder cannot show: redirects, headers, odd content types.
 * Paths match without the query string; any other path answers 404.
 */
export async function servePages(pages: Record<string, Answer>): Promise<ServedSite> {
  const server = createServer((request, response) => {
    const answer = pages[new URL(request.url ?? "/", "http://site").pathname];
    if (typeof answer === "function") return answer(request, response);
    if (answer === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Not found");
    }
    const { status = 200, headers = {}, body = "" } = typeof answer === "string" ? { body: answer } : answer;
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    response.end(body);
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

/** A small valid page with the given links and body; `faint` adds the low-contrast defect. */
export function page(title: string, links: string[], options: { faint?: boolean } = {}): string {
  const nav = links.map((href) => `<a href="${href}">Go to ${href.replace(/[<>"&]/g, "")}</a>`).join(" ");
  const faint = options.faint ? `<p style="color: #c4c4c4">This text is too faint to read.</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="color: #1a1a1a; background: #ffffff"><nav aria-label="Main">${nav}</nav><main><h1>${title}</h1>${faint}</main></body></html>`;
}

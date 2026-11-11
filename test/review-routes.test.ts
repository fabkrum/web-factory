import { afterEach, describe, expect, it } from "vitest";
import type { ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { page, servePages, type Answer } from "./harness/served-pages.ts";

interface JsonReport {
  url: string;
  routes: string[];
  passed: boolean;
  areas: { area: string; checks: { id: string; failures: { reason: string; location: string }[] }[] }[];
}

const sites: ServedSite[] = [];

afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()));
});

async function serve(pages: Record<string, Answer>): Promise<ServedSite> {
  const site = await servePages(pages);
  sites.push(site);
  return site;
}

/**
 * Route finding is the same for every Review check; these tests read it through
 * axe alone, as Lighthouse's repeated runs on every route would add minutes and
 * no coverage. test/review.test.ts runs every check.
 */
async function reviewJson(url: string) {
  const run = await runFactory(["review", url, "--json", "--check", "accessibility/axe"], { cwd: process.cwd() });
  return { run, report: run.stdout ? (JSON.parse(run.stdout) as JsonReport) : undefined };
}

function axeLocations(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks).find((check) => check.id === "accessibility/axe")!.failures.map((f) => f.location);
}

function redirect(to: string, status = 301): Answer {
  return { status, headers: { location: to }, body: "" };
}

describe("factory review finds the Site's routes", () => {
  it("follows a start address that redirects to another origin, and checks the Site there", async () => {
    const site = await serve({ "/": page("Home", ["/about"]), "/about": page("About", ["/"], { faint: true }) });
    const entry = await serve({ "/": redirect(site.url) });

    const { run, report } = await reviewJson(entry.url);

    expect(run.exitCode).toBe(1);
    expect(report!.url).toBe(site.url);
    expect(report!.routes).toEqual(["/", "/about"]);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/about /)]);
  });

  it("records a redirected route where it ends up, and leaves out routes that leave the Site", async () => {
    const foreign = await serve({ "/": page("Someone else", [], { faint: true }) });
    const site = await serve({
      "/": page("Home", ["/old", "/about", "/go-out"]),
      "/old": redirect("/about"),
      "/about": page("About", ["/"], { faint: true }),
      "/go-out": redirect(foreign.url, 302),
    });

    const { report } = await reviewJson(site.url);

    expect(report!.routes).toEqual(["/", "/about"]);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/about /)]);
  });

  it("checks pages whose last path segment has a dot, and skips links that are not pages", async () => {
    const site = await serve({
      "/": page("Home", ["/posts/node.js", "/v1.2", "/about.aspx", "/logo.png", "/data.json"]),
      "/posts/node.js": page("Node", ["/"], { faint: true }),
      "/v1.2": page("Version", ["/"], { faint: true }),
      "/about.aspx": page("About", ["/"], { faint: true }),
      "/logo.png": { headers: { "content-type": "image/png" }, body: "" },
      "/data.json": { headers: { "content-type": "application/json" }, body: "{}" },
    });

    const { report } = await reviewJson(site.url);

    expect(report!.routes).toEqual(["/", "/posts/node.js", "/v1.2", "/about.aspx"]);
    expect(axeLocations(report!).map((location) => location.split(" ")[0])).toEqual(["/posts/node.js", "/v1.2", "/about.aspx"]);
  });

  it("counts one page once, whatever query string or trailing slash its links use, even when its HTML changes on every request", async () => {
    const about: Answer = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(`About ${Math.random()}`, ["/"], { faint: true }));
    };
    const home = page("Home", ["/", "/?utm=1", "/?utm=2", "/about", "/about/", "/about?x=1", "/about/?x=2"]);
    const site = await serve({ "/": home, "/about": about, "/about/": about });

    const { report } = await reviewJson(site.url);

    expect(report!.routes).toEqual(["/", "/about"]);
    expect(axeLocations(report!)).toHaveLength(1);
  });

  it("follows links that still name the start address's origin when it redirects elsewhere", async () => {
    let entryUrl = "";
    const site = await serve({
      "/": (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(page("Home", [`${entryUrl}about`]));
      },
      "/about": page("About", ["/"], { faint: true }),
    });
    const entry = await serve({ "/": redirect(site.url), "/about": redirect(`${site.url}about`) });
    entryUrl = entry.url;

    const { run, report } = await reviewJson(entry.url);

    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/about"]);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/about /)]);
  });

  it("counts pages that differ only in their query string as one route, checked where it was first found", async () => {
    const site = await serve({
      "/": (request, response) => {
        const second = new URL(request.url ?? "/", "http://site").searchParams.get("p") === "2";
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(second ? page("Page 2", ["/"], { faint: true }) : page("Home", ["/?p=2"]));
      },
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.exitCode).toBe(0);
    expect(report!.routes).toEqual(["/"]);
  });

  it("checks a linked page at the address it was found at, query string and all", async () => {
    const site = await serve({
      "/": page("Home", ["/product?id=3"]),
      "/product": (request, response) => {
        if (!new URL(request.url ?? "/", "http://site").searchParams.has("id")) {
          response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          return response.end(page("Not found", [], { faint: true }));
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(page("Product", ["/"]));
      },
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.exitCode).toBe(0);
    expect(report!.routes).toEqual(["/", "/product"]);
  });

  it("checks a start address with a query string at that address", async () => {
    const site = await serve({
      "/": (request, response) => {
        const german = new URL(request.url ?? "/", "http://site").searchParams.get("lang") === "de";
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(page(german ? "Start" : "Home", [], { faint: german }));
      },
    });

    const { run, report } = await reviewJson(`${site.url}?lang=de`);

    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/"]);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/ /)]);
  });

  it("still tries the other form of a page when the first form it meets fails", async () => {
    const site = await serve({ "/": page("Home", ["/docs", "/docs/"]), "/docs/": page("Docs", ["/"], { faint: true }) });

    const { run, report } = await reviewJson(site.url);

    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/docs"]);
  });

  it("reviews a page that sends the browser on with a meta refresh, at the page it lands on", async () => {
    const alias = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Moved</title><meta http-equiv="refresh" content="0;url=/about"></head><body></body></html>`;
    const site = await serve({ "/": page("Home", ["/old-about"]), "/old-about": alias, "/about": page("About", ["/"], { faint: true }) });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/about"]);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/about /)]);
  });

  it("skips a link the browser cannot parse instead of crashing", async () => {
    const site = await serve({ "/": page("Home", ["http://[bad", "/about"]), "/about": page("About", ["/"]) });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(report!.routes).toEqual(["/", "/about"]);
  });

  it("reviews a Site whose Content-Security-Policy forbids inline scripts", async () => {
    const csp = { "content-security-policy": "script-src 'self'" };
    const site = await serve({
      "/": { headers: csp, body: page("Home", ["/about"]) },
      "/about": { headers: csp, body: page("About", ["/"], { faint: true }) },
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/about /)]);
  });
});

describe("factory review when one page fails", () => {
  function failures(report: JsonReport) {
    return report.areas.flatMap((area) => area.checks).find((check) => check.id === "accessibility/axe")!.failures;
  }

  it("reports a page that stops answering as that page's failure, and checks the others", async () => {
    let flakyRequests = 0;
    const site = await serve({
      "/": page("Home", ["/flaky", "/about"]),
      "/flaky": (_request, response) => {
        flakyRequests += 1;
        if (flakyRequests > 1) return response.destroy();
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(page("Flaky", ["/"]));
      },
      "/about": page("About", ["/"], { faint: true }),
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/flaky", "/about"]);
    expect(failures(report!)).toEqual([
      { location: "/flaky", reason: expect.stringMatching(/^The review could not open this page \(net::ERR_[A-Z_]+\)/) },
      { location: expect.stringMatching(/^\/about /), reason: expect.stringMatching(/contrast/) },
    ]);
  });

  it("reports a redirect loop as that page's failure, and checks the others", async () => {
    const site = await serve({
      "/": page("Home", ["/loop", "/about"]),
      "/loop": redirect("/loop/again"),
      "/loop/again": redirect("/loop"),
      "/about": page("About", ["/"], { faint: true }),
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/about", "/loop"]);
    expect(failures(report!)).toEqual([
      { location: expect.stringMatching(/^\/about /), reason: expect.stringMatching(/contrast/) },
      { location: "/loop", reason: expect.stringMatching(/redirects in a loop/) },
    ]);
  });

  it("reports a chain of meta refreshes as that page's failure, and checks the others", async () => {
    const refresh = (to: string) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Moved</title><meta http-equiv="refresh" content="0;url=${to}"></head><body></body></html>`;
    const site = await serve({
      "/": page("Home", ["/ping", "/about"]),
      "/ping": refresh("/pong"),
      "/pong": refresh("/ping"),
      "/about": page("About", ["/"], { faint: true }),
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/about", "/ping"]);
    expect(failures(report!)).toEqual([
      { location: expect.stringMatching(/^\/about /), reason: expect.stringMatching(/contrast/) },
      { location: "/ping", reason: expect.stringMatching(/keeps sending the browser on/) },
    ]);
  });

  it("reports a meta refresh to a page that never answers as that page's failure, and checks the others", async () => {
    const alias = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Moved</title><meta http-equiv="refresh" content="0;url=/hang"></head><body></body></html>`;
    const site = await serve({
      "/": page("Home", ["/alias", "/about"]),
      "/alias": alias,
      "/hang": () => {},
      "/about": page("About", ["/"], { faint: true }),
    });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "/about", "/alias"]);
    expect(failures(report!)).toEqual([
      { location: expect.stringMatching(/^\/about /), reason: expect.stringMatching(/contrast/) },
      { location: "/alias", reason: expect.stringMatching(/did not hold still within 15 seconds/) },
    ]);
  });

  it("reports a page that reloads itself as that page's failure, and checks the others", async () => {
    const reloading = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Again</title></head><body><script>location.reload()</script></body></html>`;
    const site = await serve({ "/": page("Home", ["/again", "/about"]), "/again": reloading, "/about": page("About", ["/"], { faint: true }) });

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(axeLocations(report!)).toContainEqual(expect.stringMatching(/^\/about /));
    expect(failures(report!)).toContainEqual({ location: "/again", reason: expect.stringMatching(/reloads itself/) });
  });

  it("checks a page whose path starts with // on the Site, not on a host named after its path", async () => {
    let siteUrl = "";
    const site = await serve({
      "/": (request, response) => {
        const double = request.url?.startsWith("//") ?? false;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(double ? page("Double", [], { faint: true }) : page("Home", [`${siteUrl}/double`]));
      },
    });
    siteUrl = site.url;

    const { run, report } = await reviewJson(site.url);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
    expect(report!.routes).toEqual(["/", "//double"]);
    expect(axeLocations(report!)).toEqual([expect.stringMatching(/^\/\/double /)]);
  });
});

describe("factory review when it cannot review the Site", () => {
  it("refuses a start address that is not an HTML page, with its own exit code", async () => {
    const site = await serve({ "/": { headers: { "content-type": "application/json" }, body: "{}" } });

    const { run } = await reviewJson(site.url);

    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/application\/json/);
    expect(run.stderr).toMatch(/HTML/);
  });
});

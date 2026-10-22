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

async function reviewJson(url: string) {
  const run = await runFactory(["review", url, "--json"], { cwd: process.cwd() });
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

  it("counts one page once, whatever query string, index.html or trailing slash its links use", async () => {
    const about = page("About", ["/"], { faint: true });
    const home = page("Home", ["/", "/index.html", "/?utm=1", "/?utm=2", "/about", "/about/", "/about/index.html?x=1"]);
    const site = await serve({ "/": home, "/index.html": home, "/about": about, "/about/": about, "/about/index.html": about });

    const { report } = await reviewJson(site.url);

    expect(report!.routes).toEqual(["/", "/about"]);
    expect(axeLocations(report!)).toHaveLength(1);
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

describe("factory review when it cannot review the Site", () => {
  it("refuses a start address that is not an HTML page, with its own exit code", async () => {
    const site = await serve({ "/": { headers: { "content-type": "application/json" }, body: "{}" } });

    const { run } = await reviewJson(site.url);

    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/application\/json/);
    expect(run.stderr).toMatch(/HTML/);
  });

  it("explains an unexpected stop in one plain sentence with its own exit code, not a stack trace", async () => {
    let aboutRequests = 0;
    const site = await serve({
      "/": page("Home", ["/about"]),
      "/about": (_request, response) => {
        aboutRequests += 1;
        if (aboutRequests === 1) {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(page("About", ["/"]));
        } else {
          response.destroy();
        }
      },
    });

    const { run } = await reviewJson(site.url);

    expect(run.exitCode).toBe(3);
    expect(run.stderr).toMatch(/^The review stopped before it could check your whole Site/);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).not.toMatch(/\n\s+at /);
  });
});

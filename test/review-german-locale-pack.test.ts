import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { priceWithoutGrossNote } from "../src/review/german-locale-pack.ts";
import { copyFixtureRepo, type FixtureRepo } from "./harness/fixture-repo.ts";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";
import { runFactory } from "./harness/run-factory.ts";
import { servePages, type Answer } from "./harness/served-pages.ts";

interface JsonReport {
  passed: boolean;
  areas: {
    area: string;
    note?: string;
    checks: { id: string; passed: boolean; failures: { reason: string; location: string }[] }[];
  }[];
}

const PACK_CHECKS = ["legal/impressum", "legal/privacy-policy", "legal/german-prices", "legal/third-party-fonts", "legal/third-party-requests"];

/** Every check but Lighthouse and the two that read the repository: a defect must fail exactly its own check. */
const CHECKS = [
  "accessibility/axe",
  ...PACK_CHECKS,
  "visibility/sitemap",
  "visibility/canonical",
  "visibility/one-url",
  "visibility/social-preview",
  "visibility/structured-data",
  "security/headers",
  "code/console",
];

const NOT_LEGAL_ADVICE = /not legal advice/gi;

const servers: ServedSite[] = [];
let repo: FixtureRepo | undefined;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await repo?.remove();
  repo = undefined;
});

async function serve(fixture: string): Promise<ServedSite> {
  const site = await serveFixtureSite(fixture);
  servers.push(site);
  return site;
}

async function servePagesFor(pages: Record<string, Answer>): Promise<ServedSite> {
  const site = await servePages(pages);
  servers.push(site);
  return site;
}

/** Reviews from a throwaway Site repository, with the pack on or off. */
async function review(url: string, pack: "on" | "off", flags: string[]) {
  repo = await copyFixtureRepo(pack === "on" ? "german-locale-pack" : "clean", "http://127.0.0.1:9/");
  return runFactory(["review", url, ...flags], { cwd: repo.dir });
}

async function reviewWithPack(url: string, checks = CHECKS) {
  const run = await review(url, "on", ["--json", ...checks.flatMap((id) => ["--check", id])]);
  return { run, report: JSON.parse(run.stdout) as JsonReport };
}

function failingChecks(report: JsonReport): string[] {
  return report.areas.flatMap((area) => area.checks.filter((check) => !check.passed).map((check) => check.id));
}

function checkOf(report: JsonReport, id: string) {
  return report.areas.flatMap((area) => area.checks).find((check) => check.id === id)!;
}

/** A page that passes the pack's link checks, with the given HTML in its body. */
function legalPage(body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Seite</title></head>
<body><main><h1>Seite</h1>${body}</main><footer><a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer></body></html>`;
}

function legalSite(home: string): Record<string, Answer> {
  return { "/": legalPage(home), "/impressum": legalPage(""), "/datenschutz": legalPage("") };
}

/** A server on another host name than the Site's 127.0.0.1, so what it serves is a third party's. */
async function thirdParty(): Promise<{ origin: string; requested: string[] }> {
  const requested: string[] = [];
  const answer: Answer = (request, response) => {
    requested.push(request.url ?? "");
    response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/octet-stream" });
    response.end("");
  };
  const server = await servePagesFor({ "/font.woff2": answer, "/pixel.png": answer, "/tracker.js": answer });
  return { origin: new URL(server.url).origin.replace("127.0.0.1", "localhost"), requested };
}

describe("what the German price check reads on a page", () => {
  it.each([
    ["a VAT note next to the price", "€ 49 inkl. 19 % MwSt."],
    ["a note with a decimal rate", "49 € inkl. 19,5 % MwSt."],
    ["an abbreviated note", "49 € inkl. gesetzl. MwSt."],
    ["shipping charged on top of a gross price", "49 € inkl. MwSt. zzgl. Versand"],
    ["a net price beside its gross price", "41,18 € zzgl. MwSt. (49,00 € inkl. MwSt.)"],
    ["the VAT word first", "49 €, MwSt. ist enthalten"],
    ["a gross price by name", "Bruttopreis: 49 €"],
    ["brutto beside the amount", "49 € brutto"],
    ["all prices brutto", "49 €\nAlle Preise sind brutto."],
    ["a small business in plain words", "49 €\nAls Kleinunternehmer weise ich keine Umsatzsteuer aus."],
    ["the small business rule by name", "49 €\nEs gilt die Kleinunternehmerregelung."],
  ])("accepts %s", (_, text) => {
    expect(priceWithoutGrossNote(text)).toBeUndefined();
  });

  it.each([
    ["shipping included and VAT added, with a comma", "49,00 € inkl. Versand, zzgl. MwSt."],
    ["shipping included and VAT added, without a comma", "49,00 € inkl. Versand zzgl. MwSt."],
    ["VAT left out in another sentence", "49,00 € inkl. Versand. Die MwSt. kommt hinzu."],
    ["prices that contain no VAT", "49 €\nPreise enthalten keine MwSt."],
    ["no VAT contained, the VAT word first", "49 €\nIm Preis ist keine MwSt. enthalten."],
    ["excluding VAT", "€49 excl. VAT"],
    ["plus VAT", "49 € plus MwSt."],
    ["a tariff for small businesses, net", "Tarif für Kleinunternehmer 49 € zzgl. MwSt."],
    ["a tariff for small businesses with no VAT note", "Tarif für Kleinunternehmer 49 €"],
    ["a brutto-netto calculator link", "49 €\nBrutto-Netto-Rechner"],
    ["the word brutto in a salary", "49 €\nUnser Bruttogehalt ist fair."],
    ["a dash after the comma", "49,- €"],
    ["an en dash after the comma", "49,– €"],
    ["two dashes after the comma", "49,-- EUR"],
    ["a dash with the currency first", "€ 49,-"],
    ["an amount straight after EUR", "EUR49"],
    ["a dash after the dot", "49.- €"],
    ["two dashes after the dot", "49.-- EUR"],
    ["the word Euro first", "Euro 49"],
    ["the word Euro first, with a dash", "Euro 49,-"],
  ])("fails %s", (_, text) => {
    expect(priceWithoutGrossNote(text)).toBeDefined();
  });

  it("names the price as the page shows it, its dash included", () => {
    expect(priceWithoutGrossNote("49,- €")).toBe("49,- €");
    expect(priceWithoutGrossNote("€ 49,-")).toBe("€ 49,-");
    expect(priceWithoutGrossNote("49.- €")).toBe("49.- €");
    expect(priceWithoutGrossNote("Euro 49")).toBe("Euro 49");
  });
});

describe("the German Locale pack", () => {
  it("passes a Site with an Impressum, a privacy policy, German prices and no third party", async () => {
    const site = await serve("german-clean");
    const { run, report } = await reviewWithPack(site.url);

    expect(failingChecks(report)).toEqual([]);
    expect(run.exitCode).toBe(0);
    const area = report.areas.find((area) => area.area === "Privacy & legal")!;
    expect(area.checks.map((check) => check.id)).toEqual(PACK_CHECKS);
    expect(area.note).toMatch(NOT_LEGAL_ADVICE);
  });

  it("fails a Site without an Impressum on every route that lacks the link, saying this is not legal advice", async () => {
    const site = await serve("missing-impressum");
    const { run, report } = await reviewWithPack(site.url);

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["legal/impressum"]);
    const { failures } = checkOf(report, "legal/impressum");
    expect(failures.map((failure) => failure.location)).toEqual(["/", "/about.html", "/datenschutz.html"]);
    for (const failure of failures) {
      expect(failure.reason).toMatch(/Impressum/);
      expect(failure.reason).toMatch(NOT_LEGAL_ADVICE);
    }
  });

  it("fails a Site without a privacy policy, saying this is not legal advice", async () => {
    const site = await serve("missing-privacy-policy");
    const { report } = await reviewWithPack(site.url);

    expect(failingChecks(report)).toEqual(["legal/privacy-policy"]);
    for (const failure of checkOf(report, "legal/privacy-policy").failures) {
      expect(failure.reason).toMatch(/privacy policy/i);
      expect(failure.reason).toMatch(NOT_LEGAL_ADVICE);
    }
  });

  it("does not take a link that goes nowhere for an Impressum", async () => {
    const site = await servePagesFor({ "/": legalPage("").replace('href="/impressum"', 'href="#"'), "/datenschutz": legalPage("") });
    const { report } = await reviewWithPack(site.url, ["legal/impressum"]);

    expect(failingChecks(report)).toEqual(["legal/impressum"]);
    expect(checkOf(report, "legal/impressum").failures[0]!.location).toBe("/");
  });

  it("does not take a mail address for a privacy policy, and survives a malformed link", async () => {
    const site = await servePagesFor({ "/": legalPage('<a href="http://">Broken</a> <a href="/%E0%A4%A">Odd</a>').replace('href="/datenschutz"', 'href="mailto:privacy@example.com"'), "/impressum": legalPage("") });
    const { run, report } = await reviewWithPack(site.url, ["legal/privacy-policy"]);

    expect(run.exitCode).toBe(1);
    expect(checkOf(report, "legal/privacy-policy").failures.map((failure) => failure.location)).toContain("/");
  });

  it("fails an Impressum link whose page does not answer", async () => {
    const site = await servePagesFor({ "/": legalPage(""), "/datenschutz": legalPage("") });
    const { report } = await reviewWithPack(site.url, ["legal/impressum"]);

    const failure = checkOf(report, "legal/impressum").failures.find((failure) => failure.location === "/")!;
    expect(failure.reason).toMatch(/\/impressum/);
    expect(failure.reason).toMatch(/404/);
    expect(failure.reason).toMatch(NOT_LEGAL_ADVICE);
  });

  it("fails a price shown without the German price display, naming the price", async () => {
    const site = await serve("price-without-vat");
    const { run, report } = await reviewWithPack(site.url);

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["legal/german-prices"]);
    const { failures } = checkOf(report, "legal/german-prices");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.location).toBe('/ at "49,00 €"');
    expect(failures[0]!.reason).toMatch(/inkl\. MwSt/);
    expect(failures[0]!.reason).toMatch(NOT_LEGAL_ADVICE);
  });

  it.each([
    ["a VAT note next to the price", "<p>€ 49 inkl. 19 % MwSt.</p>"],
    ["one note for the whole page", "<p>12 Euro</p><p>15 EUR</p><small>Alle Preise inklusive gesetzlicher Mehrwertsteuer.</small>"],
    ["English wording", "<p>€49.00 including VAT</p>"],
    ["the small business rule", "<p>49 €</p><p>Kein Ausweis der Umsatzsteuer gemäß § 19 UStG.</p>"],
    ["no price at all", "<p>19 Prozent aller Besucher kommen aus Bayern.</p>"],
  ])("accepts %s", async (_, body) => {
    const site = await servePagesFor(legalSite(body));
    const { report } = await reviewWithPack(site.url, ["legal/german-prices"]);

    expect(failingChecks(report)).toEqual([]);
  });

  it.each([
    ["a net price", "<p>49 € zzgl. MwSt.</p>"],
    ["a denied VAT note", "<p>49 €, nicht inkl. MwSt.</p>"],
    ["a note about shipping only", "<p>49 € inkl. Versand</p>"],
  ])("fails %s", async (_, body) => {
    const site = await servePagesFor(legalSite(body));
    const { report } = await reviewWithPack(site.url, ["legal/german-prices"]);

    expect(failingChecks(report)).toEqual(["legal/german-prices"]);
  });

  it("does not read the share capital in an Impressum as a price", async () => {
    const site = await servePagesFor({ ...legalSite(""), "/impressum": legalPage("<p>Stammkapital: 25.000 €</p>") });
    const { report } = await reviewWithPack(site.url, ["legal/german-prices"]);

    expect(failingChecks(report)).toEqual([]);
  });

  it.each([["/products/privacy-filter"], ["/shop/imprint-tshirt"], ["/datenschutz-schulung"]])("checks the price on %s, whose path only contains a legal word", async (path) => {
    const site = await servePagesFor({ ...legalSite(`<a href="${path}">Mehr</a>`), [path]: legalPage("<p>49 €</p>") });
    const { report } = await reviewWithPack(site.url, ["legal/german-prices"]);

    expect(checkOf(report, "legal/german-prices").failures.map((failure) => failure.location)).toContain(`${path} at "49 €"`);
  });

  it.each([["/datenschutz.html"], ["/impressum.htm"], ["/en/privacy-policy"], ["/de/datenschutzerklaerung"], ["/legal-notice"], ["/en/imprint"]])("does not read an amount on the legal page %s as a price", async (path) => {
    const site = await servePagesFor({ ...legalSite(`<a href="${path}">Mehr</a>`), [path]: legalPage("<p>Bußgeld bis 20.000 €</p>") });
    const { report } = await reviewWithPack(site.url, ["legal/german-prices"]);

    expect(failingChecks(report)).toEqual([]);
  });

  it("still wants the links on a route whose path only contains a legal word", async () => {
    const site = await servePagesFor({ ...legalSite('<a href="/shop/imprint-tshirt">Shirt</a> <a href="/datenschutz-schulung">Kurs</a>'), "/shop/imprint-tshirt": "<!doctype html><title>T</title><p>Shirt</p>", "/datenschutz-schulung": "<!doctype html><title>S</title><p>Kurs</p>" });
    const { report } = await reviewWithPack(site.url, ["legal/impressum", "legal/privacy-policy"]);

    expect(checkOf(report, "legal/impressum").failures.map((failure) => failure.location)).toContain("/shop/imprint-tshirt");
    expect(checkOf(report, "legal/privacy-policy").failures.map((failure) => failure.location)).toContain("/datenschutz-schulung");
  });

  it("fails a web font loaded from a third party before consent, and only as a font", async () => {
    const other = await thirdParty();
    const site = await servePagesFor(legalSite(`<style>@font-face { font-family: Far; src: url(${other.origin}/font.woff2?v=1) } h1 { font-family: Far }</style>`));
    const { run, report } = await reviewWithPack(site.url, PACK_CHECKS);

    expect(run.exitCode).toBe(1);
    expect(other.requested).toContain("/font.woff2?v=1");
    expect(failingChecks(report)).toEqual(["legal/third-party-fonts"]);
    const [failure] = checkOf(report, "legal/third-party-fonts").failures;
    expect(failure!.location).toBe(`/ to ${other.origin}/font.woff2`);
    expect(failure!.reason).toMatch(/localhost/);
    expect(failure!.reason).toMatch(NOT_LEGAL_ADVICE);
  });

  it("fails a third-party request before consent, once per page and host", async () => {
    const other = await thirdParty();
    const site = await servePagesFor(legalSite(`<img src="${other.origin}/pixel.png" alt=""><img src="${other.origin}/pixel.png?again" alt=""><script src="${other.origin}/tracker.js"></script>`));
    const { run, report } = await reviewWithPack(site.url, PACK_CHECKS);

    expect(run.exitCode).toBe(1);
    expect(failingChecks(report)).toEqual(["legal/third-party-requests"]);
    const { failures } = checkOf(report, "legal/third-party-requests");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.location).toBe(`/ to ${other.origin}/pixel.png`);
    expect(failures[0]!.reason).toMatch(/consent/);
    expect(failures[0]!.reason).toMatch(NOT_LEGAL_ADVICE);
  });

  it("catches a third-party request a script makes a moment after the page loaded", async () => {
    const other = await thirdParty();
    const site = await servePagesFor(legalSite(`<script>setTimeout(() => { new Image().src = "${other.origin}/pixel.png"; }, 300);</script>`));
    const { report } = await reviewWithPack(site.url, PACK_CHECKS);

    expect(failingChecks(report)).toEqual(["legal/third-party-requests"]);
  });

  it("passes a Site that contacts a third party only once the Visitor has agreed", async () => {
    const other = await thirdParty();
    const site = await servePagesFor(
      legalSite(`<button onclick="new Image().src = '${other.origin}/pixel.png'">Zustimmen</button>`),
    );
    const { report } = await reviewWithPack(site.url, PACK_CHECKS);

    expect(failingChecks(report)).toEqual([]);
    expect(other.requested).toEqual([]);
  });

  it("does not count a third party the Site's own Content-Security-Policy blocks: no request leaves the browser", async () => {
    const other = await thirdParty();
    const home = legalPage(`<img src="${other.origin}/pixel.png" alt="">`);
    const site = await servePagesFor({ ...legalSite(""), "/": { headers: { "content-security-policy": "img-src 'self'" }, body: home } });
    const { report } = await reviewWithPack(site.url, PACK_CHECKS);

    expect(failingChecks(report)).toEqual([]);
  });

  it("counts a subdomain of the Site as the Site's own", async () => {
    const other = await thirdParty();
    const home = await servePagesFor(legalSite(`<img src="${other.origin}/pixel.png" alt="">`));
    const { report } = await reviewWithPack(home.url.replace("127.0.0.1", "localhost"), PACK_CHECKS);

    expect(failingChecks(report)).toEqual([]);
  });

  it("states in the terminal that it is no legal advice when every pack check passes", async () => {
    const site = await serve("german-clean");
    const run = await review(site.url, "on", ["--check", "legal/impressum"]);

    expect(run.stdout.match(NOT_LEGAL_ADVICE)).toHaveLength(1);
    expect(run.stdout).toMatch(/German Locale pack is on/);
  });

  it("refuses a Locale pack the Factory does not have, in plain words", async () => {
    const site = await serve("clean");
    repo = await copyFixtureRepo("clean", "http://127.0.0.1:9/");
    await writeFile(`${repo.dir}/factory.json`, JSON.stringify({ testCommand: "true", localePack: "fr" }));
    const run = await runFactory(["review", site.url, "--check", "accessibility/axe"], { cwd: repo.dir });

    expect(run.exitCode).toBe(3);
    expect(run.stderr).toMatch(/factory\.json names the Locale pack "fr"/);
  });
});

describe("with the German Locale pack off", () => {
  it("does not check for an Impressum: the fixture Passes with one plain statement that this is not legal advice", async () => {
    const site = await serve("missing-impressum");
    const run = await review(site.url, "off", ["--check", "accessibility/axe", "--check", "visibility/canonical"]);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toMatch(/Impressum/i);
    expect(run.stdout.match(NOT_LEGAL_ADVICE)).toHaveLength(1);
    const lines = run.stdout.split("\n");
    expect(lines[lines.indexOf("Privacy & legal") + 1]).toMatch(NOT_LEGAL_ADVICE);
  });

  it("shows no pack check in the report, whichever Review checks run", async () => {
    const site = await serve("missing-impressum");
    const run = await review(site.url, "off", ["--json", "--check", "accessibility/axe"]);
    const report = JSON.parse(run.stdout) as JsonReport;

    const area = report.areas.find((area) => area.area === "Privacy & legal")!;
    expect(area.checks).toEqual([]);
    expect(area.note).toMatch(NOT_LEGAL_ADVICE);
  });

  it("gives the same statement when the review runs outside a Site's folder", async () => {
    const site = await serve("clean");
    const run = await runFactory(["review", site.url, "--check", "accessibility/axe"], { cwd: process.cwd() });

    expect(run.stdout.match(NOT_LEGAL_ADVICE)).toHaveLength(1);
  });

  it("says so when asked for a pack check by name, without opening the Site", async () => {
    const run = await review("http://127.0.0.1:9/", "off", ["--check", "legal/impressum"]);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/legal\/impressum/);
    expect(run.stderr).toMatch(/German Locale pack/);
    expect(run.stderr).toMatch(/"localePack": "de"/);
  });
});

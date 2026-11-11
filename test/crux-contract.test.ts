import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRUX_KEY_VARIABLE, CruxApi, CruxError, type CruxSource } from "../src/crux.ts";
import { FakeCrux } from "./harness/fake-crux.ts";

/** An origin with plenty of Chrome Visitors, and one nobody visits. */
const BUSY_ORIGIN = "https://web.dev";
const EMPTY_ORIGIN = "https://web-factory-has-no-visitors.example";

/** What every Chrome UX Report source does, as Measure relies on it. */
function cruxContract(name: string, subject: () => CruxSource, options: { skip?: string } = {}): void {
  const title = options.skip ? `${name} (skipped: ${options.skip})` : name;
  describe.skipIf(options.skip !== undefined)(title, { timeout: 30_000 }, () => {
    it("has nothing for an origin without enough Visitors", async () => {
      expect(await subject().query(EMPTY_ORIGIN)).toBeUndefined();
    });

    it("gives a busy origin's 75th percentiles and the 28 days they cover", async () => {
      const data = await subject().query(BUSY_ORIGIN);
      expect(data?.period).toMatch(/^\d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/);
      expect(data?.metrics.lcp).toBeGreaterThan(0);
      expect(data?.metrics.cls).toBeGreaterThanOrEqual(0);
      expect(data?.metrics.inp).toBeGreaterThan(0);
    });
  });
}

cruxContract("the fake Chrome UX Report", () => {
  const crux = new FakeCrux();
  crux.set(BUSY_ORIGIN, { period: "2026-09-01 to 2026-09-28", metrics: { lcp: 1800, cls: 0.02, inp: 150 } });
  return crux;
});

/** What the real API answers, so the adapter's reading of it runs without a key. */
function answering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

cruxContract("the Chrome UX Report adapter against recorded answers", () => {
  const recorded: typeof fetch = async (_url, init) => {
    const { origin } = JSON.parse(String(init?.body)) as { origin: string };
    if (origin !== BUSY_ORIGIN) return answering(404, { error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } })(_url);
    return answering(200, {
      record: {
        key: { origin },
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2210 } },
          cumulative_layout_shift: { percentiles: { p75: "0.04" } },
          interaction_to_next_paint: { percentiles: { p75: 180 } },
        },
        collectionPeriod: { firstDate: { year: 2026, month: 9, day: 6 }, lastDate: { year: 2026, month: 10, day: 3 } },
      },
    })(_url);
  };
  return new CruxApi({ key: "a-key", fetch: recorded });
});

describe("the Chrome UX Report adapter", () => {
  it("reads the layout shift the API sends as text as a number", async () => {
    const crux = new CruxApi({ key: "k", fetch: answering(200, { record: { metrics: { cumulative_layout_shift: { percentiles: { p75: "0.12" } } } } }) });
    expect((await crux.query(BUSY_ORIGIN))?.metrics).toEqual({ cls: 0.12 });
  });

  it("says to check the key when the API refuses it", async () => {
    const crux = new CruxApi({ key: "wrong", fetch: answering(400, { error: { message: "API key not valid" } }) });
    const refused = crux.query(BUSY_ORIGIN);
    await expect(refused).rejects.toBeInstanceOf(CruxError);
    await expect(refused).rejects.toThrow(/API key not valid.*CRUX_API_KEY/);
  });
});

/**
 * The real contract needs a Google API key with the Chrome UX Report API switched on. CI
 * sets CRUX_API_KEY from the maintainer's secret; without it this is skipped and says why.
 */
const key = process.env[CRUX_KEY_VARIABLE];
const skip = key ? undefined : `${CRUX_KEY_VARIABLE} is not set; in CI it comes from the CONTRACT_CRUX_API_KEY secret`;
if (skip) process.stderr.write(`The real Chrome UX Report contract is skipped: ${skip}\n`);
cruxContract("the Chrome UX Report API", () => new CruxApi({ key: key! }), { skip });

describe("the Chrome UX Report contract workflow", () => {
  it("runs the real contract only with the secret, and says why it is skipped otherwise", () => {
    const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/crux-contract.yml", import.meta.url)), "utf8");
    const guard = workflow.indexOf('[ -z "$CRUX_API_KEY" ]');
    expect(guard).toBeGreaterThan(-1);
    expect(workflow).toContain("::notice");
    expect(workflow).toContain("secrets.CONTRACT_CRUX_API_KEY");
    expect(workflow.indexOf("vitest run test/crux-contract.test.ts")).toBeGreaterThan(guard);
  });
});

/**
 * The Chrome UX Report: what real Visitors on Chrome experienced on a Site's origin, as the
 * 75th percentile over the last 28 days. Google lists an origin only once enough Visitors
 * opened it, so a new or small Site has no data yet.
 */

/** What the Chrome UX Report holds for an origin. */
export interface FieldData {
  /** The 28 days the numbers cover, such as "2026-10-01 to 2026-10-28". */
  period: string;
  /** 75th percentiles: largest contentful paint and interaction to next paint in ms, layout shift unitless. */
  metrics: { lcp?: number; cls?: number; inp?: number };
}

/** The boundary to the Chrome UX Report; a test fakes it. */
export interface CruxSource {
  /** The origin's field data, or `undefined` when the report has none for it yet (not enough Visitors). */
  query(origin: string): Promise<FieldData | undefined>;
}

/** The Chrome UX Report could not be asked, for a reason the Builder can read; the message is printed as it is. */
export class CruxError extends Error {}

/** The environment variable that holds the Google API key the Chrome UX Report API needs. */
export const CRUX_KEY_VARIABLE = "CRUX_API_KEY";

const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

interface Day {
  year: number;
  month: number;
  day: number;
}

interface CruxAnswer {
  record?: {
    metrics?: Record<string, { percentiles?: { p75?: number | string } }>;
    collectionPeriod?: { firstDate?: Day; lastDate?: Day };
  };
  error?: { message?: string };
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayText = (d: Day | undefined) => (d ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : "?");

/** The Chrome UX Report API, asked with the Builder's Google API key. */
export class CruxApi implements CruxSource {
  readonly #key: string;
  readonly #fetch: typeof fetch;

  constructor(options: { key: string; fetch?: typeof fetch }) {
    this.#key = options.key;
    this.#fetch = options.fetch ?? fetch;
  }

  async query(origin: string): Promise<FieldData | undefined> {
    let response: Response;
    try {
      response = await this.#fetch(`${ENDPOINT}?key=${encodeURIComponent(this.#key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin,
          metrics: ["largest_contentful_paint", "cumulative_layout_shift", "interaction_to_next_paint"],
        }),
      });
    } catch (error) {
      throw new CruxError(`The Chrome UX Report could not be reached: ${(error as Error).message}. Check the connection, then run this again.`);
    }
    // The report answers 404 for an origin it has too few Visitors for.
    if (response.status === 404) return undefined;
    const answer = (await response.json().catch(() => ({}))) as CruxAnswer;
    if (!response.ok) {
      const reason = answer.error?.message ?? `it answered ${response.status}`;
      const key = response.status === 400 || response.status === 403 ? ` Check that ${CRUX_KEY_VARIABLE} holds a Google API key with the Chrome UX Report API switched on.` : "";
      throw new CruxError(`The Chrome UX Report refused: ${reason}.${key}`);
    }
    const metrics = answer.record?.metrics ?? {};
    const p75 = (name: string): number | undefined => {
      const value = Number(metrics[name]?.percentiles?.p75);
      return metrics[name] && Number.isFinite(value) ? value : undefined;
    };
    const period = answer.record?.collectionPeriod;
    return {
      period: `${dayText(period?.firstDate)} to ${dayText(period?.lastDate)}`,
      metrics: definedOnly({ lcp: p75("largest_contentful_paint"), cls: p75("cumulative_layout_shift"), inp: p75("interaction_to_next_paint") }),
    };
  }
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

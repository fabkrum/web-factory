import type { Clock } from "./clock.ts";
import { CRUX_KEY_VARIABLE, type CruxSource } from "./crux.ts";
import { PipelineError } from "./request.ts";
import { stageLabel } from "./stages.ts";
import type { Tracker } from "./tracker.ts";

/**
 * Measure, for the Site: Lighthouse on the live Site after every Publish, and the Chrome UX
 * Report once the Site has enough Visitors. Each measurement is compared with the previous
 * one from the same source (a lab run and real Visitors are not comparable), and one that got
 * worse opens a new Request with the evidence.
 */

export type MetricId = "lcp" | "cls" | "tbt" | "inp";

export type Source = "lighthouse" | "crux";

/** One measurement of the live Site. */
export interface Measurement {
  source: Source;
  /** The address measured; for the Chrome UX Report, the Site's origin. */
  url: string;
  /** When it was measured, as an ISO time. */
  at: string;
  /** For the Chrome UX Report: the 28 days its numbers cover. */
  period?: string;
  metrics: Partial<Record<MetricId, number>>;
}

/** What Lighthouse measured on the live Site: medians, in ms except the unitless layout shift. */
export type LabMetrics = Partial<Record<"lcp" | "cls" | "tbt", number>>;

/** Runs Lighthouse on the live Site; a test fakes it. */
export type MeasureLab = (url: URL) => Promise<LabMetrics>;

interface Metric {
  name: string;
  format: (value: number) => string;
  /** A change smaller than this is noise, whatever its share. */
  noise: number;
}

const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

const METRICS: Record<MetricId, Metric> = {
  lcp: { name: "largest contentful paint", format: ms, noise: 250 },
  cls: { name: "cumulative layout shift", format: (value) => String(Math.round(value * 100) / 100), noise: 0.02 },
  tbt: { name: "total blocking time", format: ms, noise: 50 },
  inp: { name: "interaction to next paint", format: ms, noise: 25 },
};

/** A metric counts as worse only when it grew by more than this share and by more than its noise. */
const WORSE_SHARE = 0.1;

const SOURCES: Record<Source, string> = {
  lighthouse: "Lighthouse on the live Site after Publish (a lab run on a mid-range phone, median of several runs)",
  crux: "the Chrome UX Report (real Visitors on Chrome, 75th percentile over 28 days)",
};

/** The issue that keeps every measurement, in the Measure Stage. Only people who may write to the repository can label or edit it. */
export const MEASUREMENTS_TITLE = "Measurements of the live Site";
const MARKER = "factory-measurements";
/** Enough history for trends; an issue body holds at most 65536 characters. */
const KEPT_PER_SOURCE = 40;

/** One metric that got worse, with both numbers. */
export interface Regression {
  metric: MetricId;
  before: number;
  now: number;
}

/** The metrics that got worse from `before` to `now`, beyond noise. */
export function regressions(before: Measurement, now: Measurement): Regression[] {
  return (Object.keys(METRICS) as MetricId[]).flatMap((metric) => {
    const was = before.metrics[metric];
    const is = now.metrics[metric];
    if (was === undefined || is === undefined) return [];
    const worse = is - was > METRICS[metric].noise && is > was * (1 + WORSE_SHARE);
    return worse ? [{ metric, before: was, now: is }] : [];
  });
}

/** The measurement record: one issue in the Measure Stage, its body holding the history. */
async function findRecord(tracker: Tracker): Promise<{ number: number; history: Measurement[] } | undefined> {
  const label = stageLabel("measure");
  const candidates = (await tracker.openIssues())
    .filter((issue) => issue.title === MEASUREMENTS_TITLE && issue.labels.some((l) => l.toLowerCase() === label))
    .sort((a, b) => a.number - b.number);
  const [first] = candidates;
  if (!first) return undefined;
  return { number: first.number, history: parseHistory((await tracker.getIssue(first.number)).body) };
}

function parseHistory(body: string): Measurement[] {
  const match = new RegExp(`<!-- ${MARKER}\\n([\\s\\S]*?)\\n-->`).exec(body);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    return Array.isArray(parsed) ? (parsed as Measurement[]).filter((m) => m && (m.source === "lighthouse" || m.source === "crux") && typeof m.metrics === "object") : [];
  } catch {
    return [];
  }
}

function recordBody(history: Measurement[]): string {
  const rows = [...history].reverse().map((m) => {
    const values = (Object.keys(METRICS) as MetricId[])
      .filter((id) => m.metrics[id] !== undefined)
      .map((id) => `${METRICS[id].name} ${METRICS[id].format(m.metrics[id]!)}`)
      .join(", ");
    return `| ${m.at.slice(0, 16).replace("T", " ")} | ${m.source === "crux" ? `Chrome UX Report (${m.period ?? ""})` : "Lighthouse"} | ${values} |`;
  });
  return `Every measurement of the live Site, newest first. The Factory writes this issue after each Publish and each \`factory measure\`; keep it open, since the next measurement is compared with the last one here. A measurement that got worse opens a new Request.

| When (UTC) | Source | Measured |
|---|---|---|
${rows.join("\n")}

<!-- ${MARKER}
${JSON.stringify(history)}
-->
`;
}

async function record(tracker: Tracker, found: { number: number; history: Measurement[] } | undefined, measurement: Measurement): Promise<number> {
  const history = [...(found?.history ?? []), measurement];
  const kept = history.filter((m, index) => history.slice(index + 1).filter((later) => later.source === m.source).length < KEPT_PER_SOURCE);
  const body = recordBody(kept);
  if (found) {
    await tracker.updateIssue(found.number, { title: MEASUREMENTS_TITLE, body });
    return found.number;
  }
  return tracker.createIssue({ title: MEASUREMENTS_TITLE, body, stage: "measure" });
}

/** The previous measurement to compare with: same source, same address, since another Site's numbers say nothing. */
function latest(history: Measurement[], source: Source, url: string): Measurement | undefined {
  return history.filter((m) => m.source === source && m.url === url).at(-1);
}

function describe(measurement: Measurement): string {
  return (Object.keys(METRICS) as MetricId[])
    .filter((id) => measurement.metrics[id] !== undefined)
    .map((id) => `${METRICS[id].name} ${METRICS[id].format(measurement.metrics[id]!)}`)
    .join(", ");
}

function change({ metric, before, now }: Regression): string {
  const { format } = METRICS[metric];
  const share = before > 0 ? ` (+${Math.round(((now - before) / before) * 100)}%)` : "";
  return `+${format(now - before)}${share}`;
}

function requestFor(before: Measurement, now: Measurement, found: Regression[], recordNumber: number | undefined): { title: string; body: string } {
  const names = found.map((r) => METRICS[r.metric].name);
  const when = (m: Measurement) => (m.period ? `${m.at.slice(0, 10)}, covering ${m.period}` : m.at.slice(0, 16).replace("T", " "));
  const rows = found.map((r) => `| ${METRICS[r.metric].name} | ${METRICS[r.metric].format(r.before)} | ${METRICS[r.metric].format(r.now)} | ${change(r)} |`);
  return {
    title: `The live Site got worse: ${names.join(", ")} (${now.source === "crux" ? "Chrome UX Report" : "Lighthouse"})`,
    body: `Measure found the live Site worse than at its previous measurement, so it opened this Request. Ask your Agent CLI to use the spec skill on it to find out why and what to change.

Measured by ${SOURCES[now.source]}, at ${now.url}.

| Measurement | Before | Now | Change |
|---|---|---|---|
${rows.join("\n")}

Before: ${when(before)}. Now: ${when(now)}.
Each counts as worse because it grew by more than ${Math.round(WORSE_SHARE * 100)}% and by more than what one measurement to the next varies anyway.${recordNumber === undefined ? "" : `\nEvery earlier measurement is on #${recordNumber}.`}
`,
  };
}

/** Compares with the previous measurement of the same source, opens a Request when it got worse, and records it. */
async function compareAndRecord(tracker: Tracker, measurement: Measurement, found: Awaited<ReturnType<typeof findRecord>>, stdout: (text: string) => void): Promise<void> {
  const before = found && latest(found.history, measurement.source, measurement.url);
  const worse = before ? regressions(before, measurement) : [];
  if (before && worse.length > 0) {
    // The Request first: a stop before the record is written measures again and files it then.
    const request = requestFor(before, measurement, worse, found?.number);
    await tracker.ensureStageLabels();
    const number = await tracker.createIssue({ ...request, stage: "request" });
    stdout(`Worse than the previous measurement (${worse.map((r) => `${METRICS[r.metric].name} ${METRICS[r.metric].format(r.before)} → ${METRICS[r.metric].format(r.now)}`).join(", ")}), so Measure opened Request #${number} with the evidence.\n`);
  } else if (before) {
    stdout(`Not worse than the previous measurement (${describe(before)}).\n`);
  } else {
    stdout("This is the first measurement from this source, so there is nothing to compare it with yet.\n");
  }
  const recordNumber = await record(tracker, found, measurement);
  stdout(`Recorded on #${recordNumber}.\n`);
}

/** After a Publish: Lighthouse on the live Site, compared with the previous Lighthouse measurement. */
export async function measureAfterPublish(options: { url: string; measureLab: MeasureLab; tracker: Tracker; clock: Clock; stdout: (text: string) => void }): Promise<void> {
  const { url, measureLab, tracker, clock, stdout } = options;
  const metrics = await measureLab(new URL(url));
  const measurement: Measurement = { source: "lighthouse", url, at: clock.now().toISOString(), metrics };
  stdout(`Lighthouse on the live Site: ${describe(measurement) || "it measured nothing"}.\n`);
  await compareAndRecord(tracker, measurement, await findRecord(tracker), stdout);
}

/**
 * `factory measure`: the Chrome UX Report for the live Site, compared with its previous field
 * measurement. Without enough Visitors the Site is not yet measurable, which is no failure.
 */
export async function runMeasure(options: { url?: string; crux: CruxSource | undefined; tracker: Tracker; clock: Clock; stdout: (text: string) => void }): Promise<void> {
  const { crux, tracker, clock, stdout } = options;
  const found = await findRecord(tracker);
  const address = options.url ?? found?.history.at(-1)?.url;
  if (address === undefined) {
    throw new PipelineError("Measure does not know the live Site's address yet: Publish records it with its first measurement. Merge a Spec's pull request to publish, or name the address: factory measure https://my-site.web.app");
  }
  if (!crux) {
    throw new PipelineError(
      `factory measure reads the Chrome UX Report, which needs a Google API key in the ${CRUX_KEY_VARIABLE} environment variable, and none is set. Create a free key in the Google Cloud console with the Chrome UX Report API switched on, then run factory measure again with it set.`,
    );
  }
  const origin = new URL(address).origin;
  const data = await crux.query(origin);
  if (!data) {
    stdout(
      `Not yet measurable: the Chrome UX Report has no data for ${origin} yet. Google lists a Site only once enough Visitors on Chrome have opened it over 28 days, so this is no failure. Run factory measure again in a few weeks; until then, Lighthouse measures the Site after every Publish.\n`,
    );
    return;
  }
  const before = found && latest(found.history, "crux", origin);
  if (before && before.period === data.period) {
    stdout(`The Chrome UX Report has nothing new since the last measurement (${data.period}): ${describe(before)}.\n`);
    return;
  }
  const measurement: Measurement = { source: "crux", url: origin, at: clock.now().toISOString(), period: data.period, metrics: data.metrics };
  stdout(`Real Visitors on ${origin} (Chrome UX Report, ${data.period}): ${describe(measurement) || "no metric has enough data yet"}.\n`);
  await compareAndRecord(tracker, measurement, found, stdout);
}

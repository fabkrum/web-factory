import { describe, expect, it } from "vitest";
import type { MeasureLab } from "../src/measure.ts";
import { FakeClock } from "./harness/fake-clock.ts";
import { FakeCrux } from "./harness/fake-crux.ts";
import { FakeHost } from "./harness/fake-host.ts";
import { FakeTracker } from "./harness/fake-tracker.ts";
import { runFactory } from "./harness/run-factory.ts";
import { commitFile, createSiteRepo } from "./harness/site-repo.ts";

const LIVE = FakeHost.LIVE_URL;
const ORIGIN = new URL(LIVE).origin;

function site(): string {
  const dir = createSiteRepo({ testCommand: "true" });
  commitFile(dir, "index.html", "<h1>main</h1>\n");
  return dir;
}

/** Lighthouse that measures the given numbers, one set per run, and remembers what it was pointed at. */
function lab(...results: Awaited<ReturnType<MeasureLab>>[]) {
  const measured: string[] = [];
  const measureLab: MeasureLab = async (url) => {
    measured.push(url.href);
    const result = results.shift();
    if (!result) throw new Error("the fake Lighthouse has no more results");
    return result;
  };
  return { measured, measureLab };
}

async function openIssues(tracker: FakeTracker) {
  return Promise.all((await tracker.openIssues()).map(async (issue) => ({ ...issue, body: (await tracker.getIssue(issue.number)).body })));
}

const requests = async (tracker: FakeTracker) => (await openIssues(tracker)).filter((issue) => issue.labels.includes("stage:request"));
const records = async (tracker: FakeTracker) => (await openIssues(tracker)).filter((issue) => issue.labels.includes("stage:measure"));

describe("Publish measures the live Site", () => {
  it("runs Lighthouse on the live Site and records it in the Measure Stage", async () => {
    const tracker = new FakeTracker();
    const { measured, measureLab } = lab({ lcp: 1200, cls: 0.01, tbt: 80 });

    const run = await runFactory(["publish"], { cwd: site(), tracker, measureLab });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(measured).toEqual([LIVE]);
    expect(run.stdout).toMatch(/Lighthouse on the live Site: largest contentful paint 1\.2 s/);
    expect(run.stdout).toMatch(/first measurement/);
    const [record] = await records(tracker);
    expect(record?.body).toContain("1.2 s");
    expect(await requests(tracker)).toEqual([]);
  });

  it("opens a Request with the evidence when the live Site got worse than at the previous Publish", async () => {
    const tracker = new FakeTracker();
    const dir = site();
    const { measureLab } = lab({ lcp: 1200, cls: 0.01, tbt: 80 }, { lcp: 2600, cls: 0.01, tbt: 90 });
    await runFactory(["publish"], { cwd: dir, tracker, measureLab, clock: new FakeClock(new Date("2026-10-20T10:00:00Z")) });

    const run = await runFactory(["publish"], { cwd: dir, tracker, measureLab, clock: new FakeClock(new Date("2026-10-22T10:00:00Z")) });

    expect(run.exitCode, run.stderr).toBe(0);
    const [request, ...more] = await requests(tracker);
    expect(more).toEqual([]);
    expect(run.stdout).toContain(`opened Request #${request!.number}`);
    expect(request!.title).toMatch(/largest contentful paint/);
    expect(request!.title).not.toMatch(/blocking/);
    expect(request!.body).toContain("1.2 s");
    expect(request!.body).toContain("2.6 s");
    expect(request!.body).toContain(LIVE);
    expect(request!.body).toMatch(/Lighthouse/);
    expect(request!.body).toContain("2026-10-20");
    expect(request!.body).toContain("2026-10-22");
  });

  it("opens no Request for a change within what one measurement to the next varies anyway", async () => {
    const tracker = new FakeTracker();
    const dir = site();
    const { measureLab } = lab({ lcp: 1200, cls: 0.01, tbt: 80 }, { lcp: 1350, cls: 0.02, tbt: 110 }, { lcp: 1100, cls: 0.01, tbt: 70 });

    await runFactory(["publish"], { cwd: dir, tracker, measureLab });
    const second = await runFactory(["publish"], { cwd: dir, tracker, measureLab });
    const third = await runFactory(["publish"], { cwd: dir, tracker, measureLab });

    expect(second.stdout).toMatch(/Not worse/);
    expect(third.stdout).toMatch(/Not worse/);
    expect(await requests(tracker)).toEqual([]);
    expect(await records(tracker)).toHaveLength(1);
  });

  it("compares with the previous measurement, not the first", async () => {
    const tracker = new FakeTracker();
    const dir = site();
    const { measureLab } = lab({ lcp: 1200 }, { lcp: 3000 }, { lcp: 3100 });

    for (let i = 0; i < 3; i++) await runFactory(["publish"], { cwd: dir, tracker, measureLab });

    expect(await requests(tracker)).toHaveLength(1);
  });

  it("still publishes, and says why, when the live Site cannot be measured", async () => {
    const tracker = new FakeTracker();
    const host = new FakeHost();
    const measureLab: MeasureLab = async () => {
      throw new Error("no browser on this machine");
    };

    const run = await runFactory(["publish"], { cwd: site(), tracker, host, measureLab });

    expect(run.exitCode).toBe(0);
    expect(host.published).toHaveLength(1);
    expect(run.stderr).toMatch(/published, but measuring it did not finish: no browser/);
  });

  it("does not read measurements from an issue without the Measure label, which anyone may open", async () => {
    const tracker = new FakeTracker();
    const dir = site();
    const fake = await tracker.createIssue({ title: "Measurements of the live Site", body: "", stage: "request" });
    tracker.issue(fake).labels = [];
    const { measureLab } = lab({ lcp: 1200 });

    const run = await runFactory(["publish"], { cwd: dir, tracker, measureLab });

    expect(run.stdout).toMatch(/first measurement/);
    expect((await records(tracker)).map((issue) => issue.number)).not.toContain(fake);
  });
});

describe("factory measure", () => {
  const field = (period: string, metrics: { lcp?: number; cls?: number; inp?: number }) => ({ period, metrics });

  async function published(tracker: FakeTracker): Promise<string> {
    const dir = site();
    await runFactory(["publish"], { cwd: dir, tracker });
    return dir;
  }

  it("reports a Site without Chrome UX Report data as not yet measurable, not as failed", async () => {
    const tracker = new FakeTracker();
    const dir = await published(tracker);
    const crux = new FakeCrux();

    const run = await runFactory(["measure"], { cwd: dir, tracker, crux });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(crux.asked).toEqual([ORIGIN]);
    expect(run.stdout).toMatch(/Not yet measurable/);
    expect(run.stdout).not.toMatch(/fail(ed)?\b/i);
    expect(await requests(tracker)).toEqual([]);
  });

  it("checks the live Site's Chrome UX Report data and records it", async () => {
    const tracker = new FakeTracker();
    const dir = await published(tracker);
    const crux = new FakeCrux();
    crux.set(ORIGIN, field("2026-09-01 to 2026-09-28", { lcp: 1900, cls: 0.03, inp: 120 }));

    const run = await runFactory(["measure"], { cwd: dir, tracker, crux });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Real Visitors.*largest contentful paint 1\.9 s/);
    expect(run.stdout).toMatch(/first measurement from this source/);
    const [record] = await records(tracker);
    expect(record?.body).toContain("2026-09-01 to 2026-09-28");
  });

  it("opens a Request with the evidence when real Visitors had it worse than at the previous measurement", async () => {
    const tracker = new FakeTracker();
    const dir = await published(tracker);
    const crux = new FakeCrux();
    crux.set(ORIGIN, field("2026-09-01 to 2026-09-28", { lcp: 1900, cls: 0.03, inp: 120 }));
    await runFactory(["measure"], { cwd: dir, tracker, crux });
    crux.set(ORIGIN, field("2026-09-08 to 2026-10-05", { lcp: 1950, cls: 0.03, inp: 260 }));

    const run = await runFactory(["measure"], { cwd: dir, tracker, crux });

    expect(run.exitCode, run.stderr).toBe(0);
    const [request, ...more] = await requests(tracker);
    expect(more).toEqual([]);
    expect(request!.title).toMatch(/interaction to next paint/);
    expect(request!.title).not.toMatch(/largest contentful paint/);
    expect(request!.body).toContain("120 ms");
    expect(request!.body).toContain("260 ms");
    expect(request!.body).toMatch(/Chrome UX Report/);
    expect(request!.body).toContain("2026-09-08 to 2026-10-05");
  });

  it("records nothing twice when the Chrome UX Report has no new data", async () => {
    const tracker = new FakeTracker();
    const dir = await published(tracker);
    const crux = new FakeCrux();
    crux.set(ORIGIN, field("2026-09-01 to 2026-09-28", { lcp: 1900 }));
    await runFactory(["measure"], { cwd: dir, tracker, crux });
    const before = (await records(tracker))[0]!.body;

    const run = await runFactory(["measure"], { cwd: dir, tracker, crux });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/nothing new/);
    expect((await records(tracker))[0]!.body).toBe(before);
  });

  it("never compares real Visitors with a Lighthouse run", async () => {
    const tracker = new FakeTracker();
    const dir = site();
    await runFactory(["publish"], { cwd: dir, tracker, measureLab: async () => ({ lcp: 900 }) });
    const crux = new FakeCrux();
    crux.set(ORIGIN, field("2026-09-01 to 2026-09-28", { lcp: 2400 }));

    const run = await runFactory(["measure"], { cwd: dir, tracker, crux });

    expect(run.stdout).toMatch(/first measurement from this source/);
    expect(await requests(tracker)).toEqual([]);
  });

  it("measures an address the Builder names before anything was published", async () => {
    const tracker = new FakeTracker();
    const crux = new FakeCrux();

    const run = await runFactory(["measure", "https://my-site.web.app"], { cwd: site(), tracker, crux });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(crux.asked).toEqual(["https://my-site.web.app"]);
  });

  it("says where the live Site's address comes from when nothing was published", async () => {
    const run = await runFactory(["measure"], { cwd: site(), tracker: new FakeTracker(), crux: new FakeCrux() });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/Publish records it/);
  });

  it("says which key it needs when none is set", async () => {
    const tracker = new FakeTracker();
    const dir = await published(tracker);

    const run = await runFactory(["measure"], { cwd: dir, tracker });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/CRUX_API_KEY/);
  });

  it("refuses anything but one web address", async () => {
    const run = await runFactory(["measure", "my-site"], { cwd: site(), tracker: new FakeTracker(), crux: new FakeCrux() });

    expect(run.exitCode).toBe(2);
  });
});

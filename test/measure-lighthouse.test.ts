import { afterEach, describe, expect, it } from "vitest";
import { measureLive } from "../src/review/lighthouse.ts";
import { serveFixtureSite, type ServedSite } from "./harness/fixture-site.ts";

let site: ServedSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

describe("Lighthouse on the live Site", () => {
  it("measures the median of each Core Web Vital stand-in, holding nothing to a budget", async () => {
    site = await serveFixtureSite("slow-lcp");

    const metrics = await measureLive(new URL("about.html", site.url));

    // The fixture's picture arrives late, so its LCP is over the Review budget: Measure records it all the same.
    expect(metrics.lcp).toBeGreaterThan(2500);
    expect(metrics.cls).toBeGreaterThanOrEqual(0);
    expect(metrics.tbt).toBeGreaterThanOrEqual(0);
  }, 180_000);
});

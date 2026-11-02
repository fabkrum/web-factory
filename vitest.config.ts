import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review tests start a real headless browser against a fixture Site, and
    // Lighthouse measures every route of it several times.
    testTimeout: 180_000,
    // Starting or closing that browser in a hook is just as slow while the suite runs in parallel.
    hookTimeout: 60_000,
  },
});

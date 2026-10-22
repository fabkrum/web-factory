import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review tests start a real headless browser against a fixture Site, and
    // Lighthouse measures every route of it several times.
    testTimeout: 180_000,
  },
});

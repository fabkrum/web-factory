import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review tests start a real headless browser against a fixture Site.
    testTimeout: 60_000,
  },
});

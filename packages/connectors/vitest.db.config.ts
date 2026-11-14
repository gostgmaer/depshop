import { defineConfig } from "vitest/config";

// Redis-backed limiter/cache/metrics and DB status store: real Redis + *_connectors_test DB.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    env: { TEST_DATABASE_SUFFIX: "_connectors_test" },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

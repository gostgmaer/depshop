import { defineConfig } from "vitest/config";

// Load tests (Phase 7.1): real HTTP API on the *_api_test database, k6 in Docker.
export default defineConfig({
  test: {
    include: ["src/**/*.load.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    env: { TEST_DATABASE_SUFFIX: "_api_test" },
    fileParallelism: false,
    testTimeout: 360_000,
    hookTimeout: 120_000,
  },
});

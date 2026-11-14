import { defineConfig } from "vitest/config";

// API integration tests: real PostgreSQL in a dedicated *_api_test database.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    env: { TEST_DATABASE_SUFFIX: "_api_test" },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

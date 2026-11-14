import { defineConfig } from "vitest/config";

// DB integration tests: real PostgreSQL, dedicated *_test database.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    // Files share one database, so run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

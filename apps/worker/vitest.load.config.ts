import { defineConfig } from "vitest/config";

// Load tests (Phase 21): real BullMQ + PostgreSQL + Redis, mock marketplaces.
export default defineConfig({
  test: {
    include: ["src/**/*.load.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    env: { TEST_DATABASE_SUFFIX: "_worker_test" },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});

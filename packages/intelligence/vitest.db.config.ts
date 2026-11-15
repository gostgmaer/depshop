import { defineConfig } from "vitest/config";

// Matching/import integration tests: real PostgreSQL (pg_trgm), own *_catalog_test DB.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

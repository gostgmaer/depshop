import { defineConfig } from "vitest/config";

// Full-stack journey (Prompt 22): real API + worker + agent processes, mock connectors.
export default defineConfig({
  test: {
    include: ["src/**/*.journey.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    env: { TEST_DATABASE_SUFFIX: "_api_test" },
    fileParallelism: false,
    testTimeout: 400_000,
    hookTimeout: 240_000,
  },
});

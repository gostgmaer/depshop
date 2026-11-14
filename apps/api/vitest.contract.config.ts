import { defineConfig } from "vitest/config";

// Live contract tests against the shared EasyDev IAM (opt-in; needs the IAM running).
export default defineConfig({
  test: {
    include: ["src/**/*.contract.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

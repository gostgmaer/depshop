import { defineConfig } from "vitest/config";

// Unit tests only: no database required.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "src/**/*.db.test.ts",
      "src/**/*.contract.test.ts",
      "src/**/*.load.test.ts",
      "src/**/*.journey.test.ts",
      "node_modules",
      "dist",
    ],
  },
});

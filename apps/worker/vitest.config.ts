import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.db.test.ts", "src/**/*.load.test.ts"],
    passWithNoTests: true,
  },
});

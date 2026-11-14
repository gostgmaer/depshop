import { defineConfig } from "vitest/config";

// Unit tests only: no database required.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.db.test.ts", "node_modules", "dist"] },
});

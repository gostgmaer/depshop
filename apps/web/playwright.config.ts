import { defineConfig, devices } from "@playwright/test";

/**
 * E2E: the production build (`next build` first) served by `next start`,
 * talking to the E2E mock API (e2e/mock-api.ts) through the real same-origin
 * proxy and server-side session check.
 */
const WEB_PORT = 3599;
const API_PORT = 4599;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node e2e/mock-api.ts",
      url: `http://127.0.0.1:${API_PORT}/api/v1/sources/status`,
      reuseExistingServer: false,
      env: { MOCK_API_PORT: String(API_PORT) },
    },
    {
      command: `pnpm exec next start -p ${WEB_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/login`,
      reuseExistingServer: false,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}` },
      timeout: 120_000,
    },
  ],
});

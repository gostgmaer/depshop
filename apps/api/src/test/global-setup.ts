import { setupTestDatabase } from "@dealmind/db/testing";

/** API integration tests use their own database so they can run in parallel with packages/db. */
export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_SUFFIX ??= "_api_test";
  await setupTestDatabase();
}

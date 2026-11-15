import { setupTestDatabase } from "@dealmind/db/testing";

export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_SUFFIX ??= "_intelligence_test";
  await setupTestDatabase();
}

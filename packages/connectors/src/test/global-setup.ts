import { setupTestDatabase } from "@dealmind/db/testing";

export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_SUFFIX ??= "_connectors_test";
  await setupTestDatabase();
}

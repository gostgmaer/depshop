import { setupTestDatabase } from "../testing/setup.js";

export default async function setup(): Promise<void> {
  await setupTestDatabase();
}

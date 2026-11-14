/**
 * Resolves the database used by DB integration tests.
 *
 * Uses TEST_DATABASE_URL when set; otherwise derives it from DATABASE_URL by
 * appending "_test" to the database name. As a hard safety rail, tests refuse
 * to run against any database whose name does not end in "_test" or that is
 * not on a local/Docker host, because the setup wipes the target schema.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "postgres"]);

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  let raw = env.TEST_DATABASE_URL;
  if (!raw) {
    if (!env.DATABASE_URL) {
      throw new Error("DB tests need TEST_DATABASE_URL or DATABASE_URL (see .env.example)");
    }
    const derived = new URL(env.DATABASE_URL);
    // TEST_DATABASE_SUFFIX lets packages use separate DBs (e.g. "_api_test")
    // so their suites can run in parallel without wiping each other.
    const suffix = env.TEST_DATABASE_SUFFIX ?? "_test";
    derived.pathname = `${derived.pathname.replace(/^\//, "")}${suffix}`;
    raw = derived.toString();
  }
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run DB tests against "${dbName}": name must end in "_test"`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to run DB tests against non-local host "${url.hostname}"`);
  }
  return url.toString();
}

/** Same server, maintenance database: used to CREATE the test database. */
export function maintenanceUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseName(testUrl: string): string {
  return new URL(testUrl).pathname.replace(/^\//, "");
}

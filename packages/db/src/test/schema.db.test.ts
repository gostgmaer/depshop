/**
 * Structural guarantees, verified against the live PostgreSQL catalog so they
 * hold for every table, including ones added later.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createUser, testPrisma } from "./helpers.js";

const prisma = testPrisma();
afterAll(() => prisma.$disconnect());

/** Models whose rows belong to a single user (spec: each needs a userId FK). */
const USER_OWNED_TABLES = [
  "UserSession",
  "UserPreference",
  "Search",
  "SearchSourceRun",
  "SearchResult",
  "Watchlist",
  "WatchlistItem",
  "PriceAlert",
  "Notification",
  "NotificationDelivery",
  "AgentRun",
  "Subscription",
  "UsageRecord",
  "BillingEvent",
];

/** Child → parent pairs protected by composite (parentId, userId) foreign keys. */
const COMPOSITE_OWNERSHIP_FKS = [
  { table: "SearchSourceRun", parent: "Search", columns: ["searchId", "userId"] },
  { table: "SearchResult", parent: "Search", columns: ["searchId", "userId"] },
  { table: "WatchlistItem", parent: "Watchlist", columns: ["watchlistId", "userId"] },
  { table: "NotificationDelivery", parent: "Notification", columns: ["notificationId", "userId"] },
  { table: "AgentRun", parent: "Search", columns: ["searchId", "userId"] },
];

async function publicTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`;
  return rows.map((r) => r.tablename);
}

describe("schema: no multi-tenancy", () => {
  it("has no tenant, organization or membership tables or columns", async () => {
    const offenders = await prisma.$queryRaw<{ table_name: string; column_name: string | null }[]>`
      SELECT table_name, NULL::text AS column_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ~* '(tenant|organi[sz]ation|membership)'
      UNION ALL
      SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name ~* '(tenant|organi[sz]ation|membership)'`;
    expect(offenders).toEqual([]);
  });

  it("contains exactly the expected tables", async () => {
    expect(await publicTables()).toEqual(
      [
        "AffiliateClick",
        "AffiliateConversion",
        "AgentRun",
        "AiModelConfig",
        "AuditLog",
        "BillingEvent",
        "Category",
        "Notification",
        "NotificationDelivery",
        "PlatformSetting",
        "PriceAlert",
        "PriceSnapshot",
        "Product",
        "ProductOffer",
        "ProductVariant",
        "Search",
        "SearchResult",
        "SearchSourceRun",
        "ShoppingSource",
        "Subscription",
        "SubscriptionPlan",
        "UsageRecord",
        "User",
        "UserPreference",
        "UserSession",
        "Watchlist",
        "WatchlistItem",
      ].sort(),
    );
  });
});

describe("schema: user ownership", () => {
  it.each(USER_OWNED_TABLES)(
    "%s has a NOT NULL uuid userId with a FK to User(id)",
    async (table) => {
      const rows = await prisma.$queryRaw<{ nullable: string; type: string; fk: boolean }[]>`
      SELECT c.is_nullable AS nullable, c.data_type AS type,
        EXISTS (
          SELECT 1 FROM pg_constraint k
          JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
          WHERE k.contype = 'f'
            AND k.conrelid = format('%I', ${table})::regclass
            AND k.confrelid = '"User"'::regclass
            AND a.attname = 'userId'
            AND array_length(k.conkey, 1) = 1
        ) AS fk
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = ${table} AND c.column_name = 'userId'`;
      expect(rows).toEqual([{ nullable: "NO", type: "uuid", fk: true }]);
    },
  );

  it.each(COMPOSITE_OWNERSHIP_FKS)(
    "$table → $parent is a composite ($columns) ownership FK",
    async ({ table, parent, columns }) => {
      const rows = await prisma.$queryRaw<{ cols: string[] }[]>`
        SELECT array_agg(a.attname::text ORDER BY array_position(k.conkey, a.attnum)) AS cols
        FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'f'
          AND k.conrelid = format('%I', ${table})::regclass
          AND k.confrelid = format('%I', ${parent})::regclass
        GROUP BY k.oid`;
      expect(rows.map((r) => r.cols)).toContainEqual(columns);
    },
  );
});

describe("schema: types and conventions", () => {
  it("uses native uuid primary keys everywhere except natural-key tables", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; data_type: string }[]>`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name <> '_prisma_migrations'`;
    const nonUuid = rows.filter((r) => r.data_type !== "uuid");
    expect(nonUuid).toEqual([]);
    // SubscriptionPlan (code) and PlatformSetting (key) use natural keys.
    expect(rows).toHaveLength((await publicTables()).length - 2);
  });

  it("generates time-ordered UUIDv7 ids", async () => {
    const a = await createUser(prisma);
    const b = await createUser(prisma);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.id < b.id).toBe(true);
  });

  it("stores every *Paise money column as an integer type", async () => {
    const rows = await prisma.$queryRaw<
      { table_name: string; column_name: string; data_type: string }[]
    >`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%paise%'`;
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows)
      expect(["integer", "bigint"], `${r.table_name}.${r.column_name}`).toContain(r.data_type);
  });

  it("uses jsonb (never json) for JSON columns", async () => {
    const rows = await prisma.$queryRaw<{ data_type: string; n: bigint }[]>`
      SELECT data_type, count(*) AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb') GROUP BY data_type`;
    expect(rows.map((r) => r.data_type)).toEqual(["jsonb"]);
  });

  it("has pg_trgm and pgvector installed, with a trigram index on product titles", async () => {
    const ext = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'vector') ORDER BY 1`;
    expect(ext.map((e) => e.extname)).toEqual(["pg_trgm", "vector"]);
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Product_title_trgm_idx'`;
    expect(idx[0]?.indexdef).toMatch(/USING gin \(title gin_trgm_ops\)/);
  });
});

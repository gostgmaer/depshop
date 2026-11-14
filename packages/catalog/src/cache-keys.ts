/**
 * Redis key scheme of the shared catalog cache, used by the API (reads) and
 * by any importer process (invalidation after writes). Keys:
 *   <prefix>:cache:v1:catalog:<kind>:<productId>[:...]
 */
export interface RedisLike {
  scan(
    cursor: string,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    n: number,
  ): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
}

export function catalogCacheKey(prefix: string, ...parts: (string | number)[]): string {
  return [`${prefix}:cache:v1`, "catalog", ...parts.map(String)].join(":");
}

/** Per-product cache entries (detail, offer summary, offer lists, history). */
export const PRODUCT_CACHE_KINDS = ["product", "offer-summary", "offers", "history"] as const;

async function deleteTree(redis: RedisLike, key: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${key}:*`, "COUNT", 200);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
  await redis.del(key);
}

/** Removes every cached entry for these products (call after catalog writes). */
export async function invalidateProductCaches(
  redis: RedisLike,
  prefix: string,
  productIds: string[],
): Promise<void> {
  for (const id of productIds) {
    for (const kind of PRODUCT_CACHE_KINDS)
      await deleteTree(redis, catalogCacheKey(prefix, kind, id));
  }
}

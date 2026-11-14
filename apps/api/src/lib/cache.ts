/**
 * Read-through JSON cache on Redis with explicit namespaces.
 *
 * Shared catalog data lives under `catalog:*`. Private data MUST use
 * `userKey(userId, ...)`, so two users can never collide on a key.
 * Cache failures never fail a request: on any Redis error the loader runs.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

export class CacheService {
  private readonly base: string;

  constructor(
    private readonly redis: Redis,
    prefix: string,
    private readonly log: Pick<FastifyBaseLogger, "warn">,
  ) {
    this.base = `${prefix}:cache:v1`;
  }

  /** Key for shared, non-private catalog data. */
  catalogKey(...parts: (string | number)[]): string {
    return [this.base, "catalog", ...parts.map(String)].join(":");
  }

  /** Key for one user's private data; the user id is always part of the key. */
  userKey(userId: string, ...parts: (string | number)[]): string {
    if (!userId) throw new Error("userKey requires a userId");
    return [this.base, "user", userId, ...parts.map(String)].join(":");
  }

  async getOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "cache read failed; using source");
      return load();
    }
    const value = await load();
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "cache write failed");
    }
    return value;
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "cache delete failed");
    }
  }
}

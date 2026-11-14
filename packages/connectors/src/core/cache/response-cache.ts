/**
 * Query normalization, connector-response caching and request deduplication.
 *
 * Cached entries are keyed only by source + normalized request parameters —
 * never by user — so they are shared marketplace data, not anyone's search
 * history. (User searches are stored per user in PostgreSQL.)
 */
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { ConnectorSearchResult, ValidSearchRequest } from "../types/schemas.js";

/** Canonical form: NFKC, lower-case, collapsed whitespace; filters sorted. */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function requestFingerprint(r: ValidSearchRequest): string {
  const canonical = {
    q: normalizeQuery(r.query),
    c: r.category ?? null,
    b: (r.brands ?? []).map((b) => normalizeQuery(b)).sort(),
    min: r.minPricePaise ?? null,
    max: r.maxPricePaise ?? null,
    l: r.limit,
    loc: r.locale,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export interface ResponseCache {
  get(sourceId: string, fingerprint: string): Promise<ConnectorSearchResult | null>;
  set(
    sourceId: string,
    fingerprint: string,
    value: ConnectorSearchResult,
    ttlSeconds: number,
  ): Promise<void>;
  /** Drops every cached response of a source (e.g. after re-configuration). */
  invalidateSource(sourceId: string): Promise<void>;
}

function revive(json: string): ConnectorSearchResult {
  const v = JSON.parse(json) as ConnectorSearchResult;
  return {
    ...v,
    fetchedAt: new Date(v.fetchedAt),
    items: v.items.map((i) => ({
      ...i,
      observedAt: new Date(i.observedAt),
      ...(i.sourceUpdatedAt ? { sourceUpdatedAt: new Date(i.sourceUpdatedAt) } : {}),
      provenance: { ...i.provenance, retrievedAt: new Date(i.provenance.retrievedAt) },
    })),
  };
}

export class MemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<string, { json: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(sourceId: string, fp: string) {
    const e = this.entries.get(`${sourceId}:${fp}`);
    if (!e || e.expires <= this.now()) return null;
    return revive(e.json);
  }
  async set(sourceId: string, fp: string, value: ConnectorSearchResult, ttlSeconds: number) {
    if (ttlSeconds <= 0) return;
    this.entries.set(`${sourceId}:${fp}`, {
      json: JSON.stringify(value),
      expires: this.now() + ttlSeconds * 1000,
    });
  }
  async invalidateSource(sourceId: string) {
    for (const k of this.entries.keys()) if (k.startsWith(`${sourceId}:`)) this.entries.delete(k);
  }
}

export class RedisResponseCache implements ResponseCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  private key(sourceId: string, fp?: string): string {
    return `${this.prefix}:cache:v1:connector:${sourceId}${fp ? `:${fp}` : ""}`;
  }

  async get(sourceId: string, fp: string) {
    try {
      const hit = await this.redis.get(this.key(sourceId, fp));
      return hit ? revive(hit) : null;
    } catch (err) {
      this.onError(err);
      return null; // cache is an optimization; fall through to the connector
    }
  }

  async set(sourceId: string, fp: string, value: ConnectorSearchResult, ttlSeconds: number) {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(this.key(sourceId, fp), JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      this.onError(err);
    }
  }

  async invalidateSource(sourceId: string) {
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${this.key(sourceId)}:*`,
        "COUNT",
        200,
      );
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== "0");
  }
}

/**
 * Single-flight: concurrent identical requests share one in-flight call
 * (per process). Combined with the shared cache this prevents duplicate
 * marketplace requests for identical concurrent searches.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  get size(): number {
    return this.inflight.size;
  }

  run(key: string, fn: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
    const existing = this.inflight.get(key);
    if (existing) return { promise: existing, shared: true };
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return { promise, shared: false };
  }
}

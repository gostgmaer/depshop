/**
 * Source-specific rate limiting. `acquire` never blocks: it reports whether a
 * call may start now and, if not, when to retry. The executor decides whether
 * waiting fits the source's time budget (otherwise the run fails RATE_LIMITED).
 *
 * RedisRateLimiter shares the budget across every API/worker process (fixed
 * one-minute windows, atomic Lua). MemoryRateLimiter is for tests/local use.
 */
import type { Redis } from "ioredis";

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the next window when not allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  acquire(sourceId: string, limitPerMinute: number): Promise<RateLimitDecision>;
}

const WINDOW_MS = 60_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(sourceId: string, limitPerMinute: number): Promise<RateLimitDecision> {
    const t = this.now();
    const start = t - (t % WINDOW_MS);
    const w = this.windows.get(sourceId);
    const current = w && w.start === start ? w : { start, count: 0 };
    if (current.count >= limitPerMinute) {
      this.windows.set(sourceId, current);
      return { allowed: false, retryAfterMs: start + WINDOW_MS - t };
    }
    current.count += 1;
    this.windows.set(sourceId, current);
    return { allowed: true, retryAfterMs: 0 };
  }
}

// KEYS[1] = counter key; ARGV[1] = limit, ARGV[2] = window ms.
// Returns {allowed (0/1), pttl}.
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
local ttl = redis.call('PTTL', KEYS[1])
if n > tonumber(ARGV[1]) then return {0, ttl} end
return {1, ttl}`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  async acquire(sourceId: string, limitPerMinute: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const window = now - (now % WINDOW_MS);
    const key = `${this.prefix}:connectors:rl:${sourceId}:${window}`;
    try {
      const [allowed, ttl] = (await this.redis.eval(SCRIPT, 1, key, limitPerMinute, WINDOW_MS)) as [
        number,
        number,
      ];
      return { allowed: allowed === 1, retryAfterMs: allowed === 1 ? 0 : Math.max(ttl, 0) };
    } catch (err) {
      // Fail closed: if the shared budget can't be checked, don't risk
      // exceeding a marketplace's limit.
      this.onError(err);
      return { allowed: false, retryAfterMs: 1_000 };
    }
  }
}

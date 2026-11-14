/**
 * Per-account login throttling, complementing the per-IP route rate limit:
 * it stops a distributed (many-IP) password-guessing attack on one account.
 *
 * After `maxFailures` failed attempts within `windowMs`, the key is locked for
 * `lockMs`. Callers answer with a generic message so a lock does not reveal
 * whether the account exists.
 *
 * Two implementations share one interface:
 *  - RedisLoginThrottle: production; shared across API instances.
 *  - MemoryLoginThrottle: unit tests and single-process tooling.
 */
import type { Redis } from "ioredis";

export interface LoginThrottleOptions {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}

export interface LoginThrottle {
  isLocked(key: string): Promise<boolean>;
  recordFailure(key: string): Promise<void>;
  recordSuccess(key: string): Promise<void>;
}

export class RedisLoginThrottle implements LoginThrottle {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly opts: LoginThrottleOptions,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  private keys(key: string) {
    const k = encodeURIComponent(key.toLowerCase());
    return {
      fails: `${this.prefix}:auth:throttle:fails:${k}`,
      lock: `${this.prefix}:auth:throttle:lock:${k}`,
    };
  }

  /**
   * Fails OPEN on Redis errors: an outage must not lock every user out. The
   * per-IP limit and the IAM's own throttling still apply.
   */
  async isLocked(key: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.keys(key).lock)) === 1;
    } catch (err) {
      this.onError(err);
      return false;
    }
  }

  async recordFailure(key: string): Promise<void> {
    const { fails, lock } = this.keys(key);
    try {
      const [[, count]] = (await this.redis
        .multi()
        .incr(fails)
        .pexpire(fails, this.opts.windowMs, "NX")
        .exec()) as [[Error | null, number], unknown];
      if (count >= this.opts.maxFailures) {
        await this.redis.multi().set(lock, "1", "PX", this.opts.lockMs).del(fails).exec();
      }
    } catch (err) {
      this.onError(err);
    }
  }

  async recordSuccess(key: string): Promise<void> {
    const { fails, lock } = this.keys(key);
    try {
      await this.redis.del(fails, lock);
    } catch (err) {
      this.onError(err);
    }
  }
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export class MemoryLoginThrottle implements LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly opts: LoginThrottleOptions,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    return Promise.resolve(!!entry && entry.lockedUntil > this.now());
  }

  recordFailure(key: string): Promise<void> {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < this.opts.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.opts.maxFailures) {
      entry.lockedUntil = now + this.opts.lockMs;
      entry.failures = [];
    }
    this.entries.set(key, entry);
    return Promise.resolve();
  }

  recordSuccess(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

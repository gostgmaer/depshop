/**
 * Per-account login throttling, complementing the per-IP route rate limit:
 * it stops a distributed (many-IP) password-guessing attack on one account.
 *
 * After `maxFailures` failed attempts within `windowMs`, the account is locked
 * for `lockMs`. Callers respond with the same generic message used for wrong
 * credentials, so the lock does not reveal whether the account exists.
 *
 * State is in-process memory (per API instance). TODO(phase-7): move to Redis
 * when the API runs as multiple instances.
 */
export interface LoginThrottleOptions {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly opts: LoginThrottleOptions) {
    this.now = opts.now ?? Date.now;
  }

  isLocked(key: string): boolean {
    const entry = this.entries.get(key);
    return !!entry && entry.lockedUntil > this.now();
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < this.opts.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.opts.maxFailures) {
      entry.lockedUntil = now + this.opts.lockMs;
      entry.failures = [];
    }
    this.entries.set(key, entry);
    if (this.entries.size > 50_000) this.prune();
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= now && e.failures.every((t) => now - t >= this.opts.windowMs)) {
        this.entries.delete(key);
      }
    }
  }
}

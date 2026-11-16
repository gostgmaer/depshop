/**
 * One Redis subscriber per API process, fanned out to the open SSE streams
 * of each user. A user's channel is subscribed while they have a stream open
 * and only their own streams receive its messages.
 */
import { userNotificationChannel } from "@dealmind/notifications";
import type { Redis } from "ioredis";

type Listener = (message: string) => void;

export class RealtimeHub {
  private sub: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private subscriber(): Redis {
    if (!this.sub) {
      // Queue commands until connected (the shared client may disable its offline queue).
      this.sub = this.redis.duplicate({ enableOfflineQueue: true });
      this.sub.on("error", () => undefined);
      this.sub.on("message", (channel: string, message: string) => {
        const userId = channel.slice(channel.lastIndexOf(":") + 1);
        for (const l of this.listeners.get(userId) ?? []) l(message);
      });
    }
    return this.sub;
  }

  /** Number of open streams of this user on this process. */
  count(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }

  async add(userId: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
      await this.subscriber().subscribe(userNotificationChannel(this.prefix, userId));
    }
    set.add(listener);
    return async () => {
      const s = this.listeners.get(userId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.delete(userId);
        await this.sub
          ?.unsubscribe(userNotificationChannel(this.prefix, userId))
          .catch(() => undefined);
      }
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await this.sub?.quit().catch(() => undefined);
    this.sub = null;
  }
}

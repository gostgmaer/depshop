/**
 * Redis client shared by caching, rate limiting, login throttling and queue
 * producers. Configured to fail fast: while Redis is down, commands reject
 * immediately (no offline queue) so requests degrade instead of hanging, and
 * /ready reports the outage.
 *
 * Key namespaces (all under REDIS_KEY_PREFIX, default "dm"):
 *   <p>:cache:v1:catalog:*          shared catalog reads
 *   <p>:cache:v1:user:<userId>:*    private, always scoped by user id
 *   <p>:rl:*                        rate-limit counters
 *   <p>:auth:throttle:*             per-account login throttling
 *   <p>:bull:*                      BullMQ queues
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Redis } from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    // Keep reconnecting in the background; commands fail fast meanwhile.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export const redisPlugin = fp<{ redis: Redis }>(
  (app: FastifyInstance, { redis }, done) => {
    // Connection errors are expected during outages; log, don't crash.
    redis.on("error", (err: Error) => app.log.warn({ err: err.message }, "Redis connection error"));
    app.decorate("redis", redis);
    app.addHook("onClose", async () => {
      await redis.quit().catch(() => redis.disconnect());
    });
    done();
  },
  { name: "redis" },
);

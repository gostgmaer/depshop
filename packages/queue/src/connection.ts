import type { ConnectionOptions } from "bullmq";

/**
 * BullMQ connection options from a redis:// URL (password and DB index
 * included). `maxRetriesPerRequest: null` is required by BullMQ workers.
 */
export function redisConnectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, "");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

/**
 * Real-time in-app updates: the worker/API publish a small signal on the
 * user's own Redis channel after commit; the API's SSE stream forwards it to
 * that user's open tabs only. The signal carries ids, not content: clients
 * re-fetch through the authenticated API.
 */
export const userNotificationChannel = (prefix: string, userId: string) =>
  `${prefix}:notifications:user:${userId}`;

export type RealtimeSignal =
  | { type: "created"; id: string }
  | { type: "read"; id: string }
  | { type: "read-all" }
  | { type: "deleted"; id: string };

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/** Best effort: a lost signal only delays the badge until the next poll. */
export async function publishSignal(
  redis: Publisher | null | undefined,
  prefix: string,
  userId: string,
  signal: RealtimeSignal,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.publish(userNotificationChannel(prefix, userId), JSON.stringify(signal));
  } catch {
    /* ignored: polling covers it */
  }
}

/**
 * Phase 5.3 worker: notification delivery. Channels are independent;
 * retries are idempotent; permanent failures stop; transient ones retry and
 * dead-letter; quiet hours delay (never drop); consent is re-checked at send
 * time; gone push subscriptions expire; search notices come from the
 * committed search status. Providers are scripted fakes (no external calls).
 */
import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import {
  DeliveryError,
  type EmailMessage,
  type NotificationEvent,
  type PushPayload,
  type PushTarget,
  buildNotification,
  recordNotification,
} from "@dealmind/notifications";
import { QueueName, notificationDeliveryJob, redisConnectionFromUrl } from "@dealmind/queue";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type NotificationDeps,
  processNotificationDelivery,
} from "../processors/notification.processor.js";
import { NOTIFICATION_BACKOFF } from "../queues/notification.queue.js";
import { runCleanup } from "../schedulers/cleanup.scheduler.js";
import { notifySearchFinished } from "../services/search-notifications.js";
import { TrackingMetrics } from "../services/tracking-metrics.js";
import { createTrackedWorker } from "../workers/tracked-worker.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
const redisUrl = process.env.REDIS_URL!;
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
const prefix = `dmnotif${randomUUID().slice(0, 8)}`;
const metrics = new TrackingMetrics(redis, prefix);
const NOW = new Date("2026-11-21T10:00:00.000Z"); // 15:30 IST
const ctx1 = { attempt: 1, maxAttempts: 3 };

class FakeEmail {
  readonly name = "fake";
  sent: EmailMessage[] = [];
  failures: DeliveryError[] = [];
  async send(m: EmailMessage) {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push(m);
    return { messageId: `m-${this.sent.length}` };
  }
}
class FakePush {
  readonly publicKey = "test";
  sent: { endpoint: string; payload: PushPayload }[] = [];
  /** endpoint → errors to throw, in order */
  failures = new Map<string, DeliveryError[]>();
  async send(t: PushTarget, payload: PushPayload) {
    const f = this.failures.get(t.endpoint)?.shift();
    if (f) throw f;
    this.sent.push({ endpoint: t.endpoint, payload });
  }
}

let email: FakeEmail;
let push: FakePush;
const deps = (over: Partial<NotificationDeps> = {}): NotificationDeps => ({
  prisma,
  metrics,
  email,
  push,
  appUrl: "https://dealmind.example",
  tokenSecret: "s".repeat(40),
  now: () => NOW,
  ...over,
});

let n = 0;
async function user(prefs: Record<string, unknown> = {}) {
  n += 1;
  const u = await prisma.user.create({
    data: { email: `n${n}@example.com`, name: `User ${n}`, iamUserId: randomUUID() },
  });
  await prisma.userPreference.create({ data: { userId: u.id, notifyPush: true, ...prefs } });
  return u;
}
const subscribe = (userId: string, endpoint: string) =>
  prisma.pushSubscription.create({
    data: { userId, endpoint, p256dh: "p", auth: "a" },
  });
async function record(event: NotificationEvent, now = NOW) {
  const r = await prisma.$transaction((tx) =>
    recordNotification(tx, buildNotification(event), { now }),
  );
  if (r.status !== "created") throw new Error(r.status);
  return r;
}
const alertEvent = (userId: string): NotificationEvent => ({
  kind: "alert.expired",
  userId,
  alertId: randomUUID(),
  product: { id: randomUUID(), name: "Acme Nova 7", variantId: randomUUID() },
  expiresAt: NOW.toISOString(),
});
const delivery = (notificationId: string, channel: "EMAIL" | "PUSH") =>
  prisma.notificationDelivery.findUniqueOrThrow({
    where: { notificationId_channel: { notificationId, channel } },
  });

beforeEach(async () => {
  await truncateAll(prisma);
  email = new FakeEmail();
  push = new FakePush();
});
afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
  await prisma.$disconnect();
});

describe("channels are independent", () => {
  it("email fails permanently while push and in-app still deliver", async () => {
    const u = await user();
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/a");
    const r = await record(alertEvent(u.id));
    expect(r.inApp).toBe(true);
    expect(r.pending.map((d) => d.channel).sort()).toEqual(["EMAIL", "PUSH"]);
    email.failures.push(new DeliveryError("Notification service 400: bad address", true));
    const e = await delivery(r.notificationId, "EMAIL");
    const p = await delivery(r.notificationId, "PUSH");
    expect(await processNotificationDelivery(deps(), { deliveryId: e.id }, ctx1)).toEqual({
      action: "done",
      status: "FAILED",
    });
    expect(await processNotificationDelivery(deps(), { deliveryId: p.id }, ctx1)).toEqual({
      action: "done",
      status: "SENT",
    });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload.url).toMatch(/^\/products\//);
    expect((await delivery(r.notificationId, "EMAIL")).lastError).toMatch(/bad address/);
  });
});

describe("email", () => {
  it("retries a transient failure with the same idempotency key, then sends once", async () => {
    const u = await user();
    const r = await record(alertEvent(u.id));
    const e = await delivery(r.notificationId, "EMAIL");
    email.failures.push(new DeliveryError("timeout", false));
    expect(await processNotificationDelivery(deps(), { deliveryId: e.id }, ctx1)).toMatchObject({
      action: "retry",
    });
    expect((await delivery(r.notificationId, "EMAIL")).attempts).toBe(1);
    expect(
      await processNotificationDelivery(deps(), { deliveryId: e.id }, { ...ctx1, attempt: 2 }),
    ).toEqual({ action: "done", status: "SENT" });
    expect(
      await processNotificationDelivery(deps(), { deliveryId: e.id }, { ...ctx1, attempt: 3 }),
    ).toEqual({ action: "done", status: "NOT_PENDING" });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ idempotencyKey: e.id, to: u.email });
    expect(email.sent[0]!.text).toMatch(/https:\/\/dealmind\.example\/unsubscribe\?token=/);
    const d = await delivery(r.notificationId, "EMAIL");
    expect(d).toMatchObject({ status: "SENT", attempts: 2, providerMessageId: "m-1" });
  });

  it("records FAILED after the last attempt and fails the job (so it is dead-lettered)", async () => {
    const u = await user();
    const r = await record(alertEvent(u.id));
    const e = await delivery(r.notificationId, "EMAIL");
    email.failures.push(new DeliveryError("503", false));
    expect(
      await processNotificationDelivery(
        deps(),
        { deliveryId: e.id },
        { attempt: 3, maxAttempts: 3 },
      ),
    ).toMatchObject({ action: "retry" });
    expect((await delivery(r.notificationId, "EMAIL")).status).toBe("FAILED");
  });

  it("skips when the user turned email off before it was sent (consent at send time)", async () => {
    const u = await user();
    const r = await record(alertEvent(u.id));
    const e = await delivery(r.notificationId, "EMAIL");
    await prisma.userPreference.update({ where: { userId: u.id }, data: { notifyEmail: false } });
    expect(await processNotificationDelivery(deps(), { deliveryId: e.id }, ctx1)).toEqual({
      action: "done",
      status: "SKIPPED",
    });
    expect(email.sent).toHaveLength(0);
    expect((await delivery(r.notificationId, "EMAIL")).lastError).toMatch(/at send time/);
  });

  it("skips without a provider", async () => {
    const u = await user();
    const r = await record(alertEvent(u.id));
    const e = await delivery(r.notificationId, "EMAIL");
    expect(
      await processNotificationDelivery(deps({ email: null }), { deliveryId: e.id }, ctx1),
    ).toEqual({ action: "done", status: "SKIPPED" });
  });
});

describe("web push", () => {
  it("expires gone subscriptions, delivers to the rest, and never resends on retry", async () => {
    const u = await user();
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/gone");
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/flaky");
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/ok");
    const r = await record(alertEvent(u.id));
    const p = await delivery(r.notificationId, "PUSH");
    push.failures.set("https://fcm.googleapis.com/fcm/send/gone", [
      new DeliveryError("410", true, true),
    ]);
    push.failures.set("https://fcm.googleapis.com/fcm/send/flaky", [
      new DeliveryError("503", false),
    ]);

    expect(await processNotificationDelivery(deps(), { deliveryId: p.id }, ctx1)).toMatchObject({
      action: "retry",
    });
    expect(push.sent.map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/ok"]);
    const gone = await prisma.pushSubscription.findUniqueOrThrow({
      where: { endpoint: "https://fcm.googleapis.com/fcm/send/gone" },
    });
    expect(gone.expiredAt).not.toBeNull();

    expect(
      await processNotificationDelivery(deps(), { deliveryId: p.id }, { ...ctx1, attempt: 2 }),
    ).toEqual({ action: "done", status: "SENT" });
    // The retry went only to the subscription that hadn't received it.
    expect(push.sent.map((s) => s.endpoint)).toEqual([
      "https://fcm.googleapis.com/fcm/send/ok",
      "https://fcm.googleapis.com/fcm/send/flaky",
    ]);
    expect((await delivery(r.notificationId, "PUSH")).sentTo).toHaveLength(2);
  });

  it("is skipped when push is off, and fails when every subscription is gone", async () => {
    const off = await user({ notifyPush: false });
    await subscribe(off.id, "https://fcm.googleapis.com/fcm/send/off");
    const r1 = await record(alertEvent(off.id));
    expect((await delivery(r1.notificationId, "PUSH")).status).toBe("SKIPPED");

    const u = await user();
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/only");
    const r2 = await record(alertEvent(u.id));
    push.failures.set("https://fcm.googleapis.com/fcm/send/only", [
      new DeliveryError("404", true, true),
    ]);
    const p = await delivery(r2.notificationId, "PUSH");
    expect(await processNotificationDelivery(deps(), { deliveryId: p.id }, ctx1)).toEqual({
      action: "done",
      status: "FAILED",
    });
  });
});

describe("quiet hours", () => {
  it("delays email and push until quiet hours end; in-app is immediate; critical isn't delayed", async () => {
    const u = await user({ quietHoursStart: "15:00", quietHoursEnd: "16:00" });
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/q");
    const r = await record(alertEvent(u.id));
    const end = new Date("2026-11-21T10:30:00.000Z"); // 16:00 IST
    expect(r.inApp).toBe(true);
    expect(r.pending.map((d) => d.notBefore.toISOString())).toEqual([
      end.toISOString(),
      end.toISOString(),
    ]);
    const e = await delivery(r.notificationId, "EMAIL");
    const early = await processNotificationDelivery(deps(), { deliveryId: e.id }, ctx1);
    expect(early).toMatchObject({ action: "delay", ms: 30 * 60_000 });
    expect(email.sent).toHaveLength(0);
    expect(
      await processNotificationDelivery(deps({ now: () => end }), { deliveryId: e.id }, ctx1),
    ).toEqual({ action: "done", status: "SENT" });

    const c = await record({
      kind: "account.password_changed",
      userId: u.id,
      auditId: randomUUID(),
      at: NOW.toISOString(),
    });
    expect(c.pending).toEqual([expect.objectContaining({ channel: "PUSH", notBefore: NOW })]);
  });
});

describe("recovery and dead letters", () => {
  let queues: Queue[] = [];
  afterEach(async () => {
    await Promise.all(queues.map((q) => q.obliterate({ force: true }).catch(() => undefined)));
    await Promise.all(queues.map((q) => q.close()));
    queues = [];
  });

  it("cleanup re-enqueues deliveries still pending after they were due", async () => {
    const u = await user();
    await subscribe(u.id, "https://fcm.googleapis.com/fcm/send/r");
    const r = await record(alertEvent(u.id), new Date(Date.now() - 20 * 60_000));
    const enqueued: string[] = [];
    const res = await runCleanup({
      prisma,
      enqueueDelivery: async (id) => void enqueued.push(id),
    });
    expect(res.requeuedDeliveries).toBe(2);
    expect(enqueued.sort()).toEqual(r.pending.map((d) => d.id).sort());
  });

  it("dead-letters a delivery whose retries run out and marks it FAILED", async () => {
    const u = await user();
    const r = await record(alertEvent(u.id), new Date());
    const e = (await delivery(r.notificationId, "EMAIL")).id;
    const connection = redisConnectionFromUrl(redisUrl);
    const bullPrefix = `${prefix}:bull`;
    const q = new Queue(QueueName.notificationDelivery, { connection, prefix: bullPrefix });
    const dlq = new Queue(QueueName.deadLetter, { connection, prefix: bullPrefix });
    queues.push(q, dlq);
    const events = new QueueEvents(QueueName.notificationDelivery, {
      connection,
      prefix: bullPrefix,
    });
    await events.waitUntilReady();
    const failing = new FakeEmail();
    for (let i = 0; i < 5; i++) failing.failures.push(new DeliveryError("503", false));
    const worker = createTrackedWorker({
      connection,
      prefix: bullPrefix,
      deadLetter: dlq,
      metrics,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as never,
      queue: QueueName.notificationDelivery,
      schema: notificationDeliveryJob,
      concurrency: 1,
      backoff: { ...NOTIFICATION_BACKOFF, baseMs: 10, capMs: 20 },
      process: (data, c) =>
        processNotificationDelivery(deps({ email: failing, now: () => new Date() }), data, {
          attempt: c.attempt,
          maxAttempts: 3,
        }),
      onDeadLetter: async (data, reason) => {
        await prisma.notificationDelivery.updateMany({
          where: { id: data.deliveryId, status: "PENDING" },
          data: { status: "FAILED", lastError: reason.slice(0, 500) },
        });
      },
    });
    try {
      await q.add(
        QueueName.notificationDelivery,
        { deliveryId: e },
        { jobId: `delivery.${e}`, attempts: 3, backoff: { type: "jitter", delay: 10 } },
      );
      const deadline = Date.now() + 15_000;
      while ((await dlq.count()) === 0 && Date.now() < deadline)
        await new Promise((ok) => setTimeout(ok, 100));
      expect(await dlq.count()).toBe(1);
      const d = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: e } });
      expect(d.status).toBe("FAILED");
      expect(failing.sent).toHaveLength(0);
    } finally {
      await worker.close();
      await events.close();
    }
  });
});

describe("search notifications", () => {
  async function search(userId: string, status: string, seconds: number) {
    const created = new Date(Date.now() - seconds * 1000);
    return prisma.search.create({
      data: {
        userId,
        query: "phones under ₹30,000",
        status: status as never,
        createdAt: created,
        completedAt: new Date(),
      },
    });
  }

  it("notifies long searches once (completed, partial or failed), never quick or cancelled ones", async () => {
    const u = await user();
    const enqueued: string[] = [];
    const d = {
      prisma,
      enqueueDelivery: async (id: string) => void enqueued.push(id),
      minSeconds: 20,
    };
    const long = await search(u.id, "PARTIAL", 60);
    expect(await notifySearchFinished(d, long.id)).toBe("created");
    expect(await notifySearchFinished(d, long.id)).toBe("duplicate");
    const quick = await search(u.id, "COMPLETED", 3);
    expect(await notifySearchFinished(d, quick.id)).toBe("not-applicable");
    const cancelled = await search(u.id, "CANCELLED", 60);
    expect(await notifySearchFinished(d, cancelled.id)).toBe("not-applicable");
    const failed = await search(u.id, "FAILED", 60);
    expect(await notifySearchFinished(d, failed.id)).toBe("created");
    const notes = await prisma.notification.findMany({ orderBy: { createdAt: "asc" } });
    expect(notes.map((x) => [x.type, x.sourceType, x.sourceId])).toEqual([
      ["SEARCH_COMPLETED", "SEARCH", long.id],
      ["SEARCH_FAILED", "SEARCH", failed.id],
    ]);
    expect(notes[0]!.body).toMatch(/partial/);
    // Search emails are off by default; push is off for the SEARCH category by default.
    expect(enqueued).toEqual([]);
  });
});

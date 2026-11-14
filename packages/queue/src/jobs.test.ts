import { describe, expect, it } from "vitest";
import { redisConnectionFromUrl } from "./connection.js";
import { JOBS, QueueName } from "./jobs.js";

const id = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("job contracts", () => {
  it("derives deterministic job ids (idempotent enqueue)", () => {
    const search = JOBS[QueueName.shoppingSearch];
    expect(search.jobId({ searchId: id, userId: id })).toBe(`search:${id}`);
    expect(JOBS[QueueName.priceRefresh].jobId({ offerId: id, slot: "2026-11-14T12:00" })).toBe(
      `price:${id}:2026-11-14T12:00`,
    );
    expect(JOBS[QueueName.notificationDelivery].jobId({ deliveryId: id })).toBe(`delivery:${id}`);
  });

  it("rejects malformed payloads", () => {
    expect(
      JOBS[QueueName.shoppingSearch].schema.safeParse({ searchId: "x", userId: id }).success,
    ).toBe(false);
    expect(JOBS[QueueName.alertEvaluation].schema.safeParse({ variantId: id }).success).toBe(false);
  });

  it("parses redis URLs including password and db index", () => {
    expect(redisConnectionFromUrl("redis://:s%40cret@127.0.0.1:16379/3")).toMatchObject({
      host: "127.0.0.1",
      port: 16379,
      password: "s@cret",
      db: 3,
      maxRetriesPerRequest: null,
    });
  });
});

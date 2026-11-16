import { describe, expect, it } from "vitest";
import { ALERT_STATUSES, canTransition, createAlertInput, updateAlertInput } from "./contracts.js";

const variantId = "20000000-0000-7000-8000-000000000001";

describe("alert lifecycle", () => {
  it("allows only the documented transitions", () => {
    const allowed = (action: Parameters<typeof canTransition>[0]) =>
      ALERT_STATUSES.filter((s) => canTransition(action, s));
    expect(allowed("pause")).toEqual(["ACTIVE"]);
    expect(allowed("resume")).toEqual(["PAUSED", "TRIGGERED"]);
    expect(allowed("cancel")).toEqual(["ACTIVE", "PAUSED", "TRIGGERED"]);
    expect(allowed("update")).toEqual(["ACTIVE", "PAUSED", "TRIGGERED"]);
    // Expired and cancelled alerts are final (they can only be deleted).
    expect(canTransition("resume", "EXPIRED")).toBe(false);
    expect(canTransition("resume", "CANCELLED")).toBe(false);
    expect(allowed("delete")).toEqual([...ALERT_STATUSES]);
  });
});

describe("alert inputs", () => {
  it("accepts each condition with its own parameters only", () => {
    const ok = (v: object) => createAlertInput.safeParse({ variantId, ...v }).success;
    expect(ok({ targetPricePaise: 3_000_000 })).toBe(true); // legacy shape → TARGET_PRICE
    expect(ok({ type: "PRICE_DROP" })).toBe(true);
    expect(ok({ type: "PRICE_DROP", minChangePaise: 50_000, channels: ["IN_APP"] })).toBe(true);
    expect(ok({ type: "PRICE_CHANGE", minChangePaise: 10_000 })).toBe(true);
    expect(ok({ type: "TARGET_PRICE", targetPricePaise: 1, minChangePaise: 5 })).toBe(false);
    expect(ok({ type: "PRICE_DROP", targetPricePaise: 1 })).toBe(false);
    expect(ok({ type: "BACK_IN_STOCK", channels: [] })).toBe(false);
    expect(ok({ type: "BACK_IN_STOCK", channels: ["PUSH"] })).toBe(true);
    expect(ok({ type: "BACK_IN_STOCK", channels: ["EMAIL", "EMAIL"] })).toBe(false);
    expect(ok({ type: "BACK_IN_STOCK", channels: ["SMS"] })).toBe(false);
    expect(ok({ type: "BACK_IN_STOCK", expiresAt: "2020-01-01T00:00:00Z" })).toBe(false);
    expect(
      ok({ type: "BACK_IN_STOCK", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ).toBe(true);
    // Ownership is never taken from the client.
    expect(ok({ targetPricePaise: 100, userId: variantId })).toBe(false);
  });

  it("lets an update clear the expiry or the minimum change", () => {
    expect(updateAlertInput.safeParse({ expiresAt: null }).success).toBe(true);
    expect(updateAlertInput.safeParse({ minChangePaise: null }).success).toBe(true);
    expect(updateAlertInput.safeParse({}).success).toBe(false);
    expect(updateAlertInput.safeParse({ status: "ACTIVE" }).success).toBe(false);
  });
});

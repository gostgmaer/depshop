import { describe, expect, it } from "vitest";
import {
  MoneyError,
  discountBasisPoints,
  formatBasisPoints,
  formatPaise,
  paise,
  parseRupeesToPaise,
  savingsPaise,
} from "./money.js";

describe("paise", () => {
  it("accepts non-negative safe integers", () => {
    expect(paise(0)).toBe(0);
    expect(paise(12_499_900)).toBe(12_499_900);
  });
  it.each([1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects %s", (v) => {
    expect(() => paise(v)).toThrow(MoneyError);
  });
});

describe("parseRupeesToPaise", () => {
  it.each([
    ["₹1,24,999.00", 12_499_900],
    ["Rs. 499", 49_900],
    ["INR 1299.5", 129_950],
    ["0.07", 7],
    ["  ₹ 99  ", 9_900],
  ])("parses %s", (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected);
  });
  it.each(["", "abc", "12.345", "-5", "1e3"])("rejects %s", (input) => {
    expect(() => parseRupeesToPaise(input)).toThrow(MoneyError);
  });
  it("does not introduce floating-point error", () => {
    expect(parseRupeesToPaise("0.29")).toBe(29);
    expect(parseRupeesToPaise("1.10")).toBe(110);
  });
});

describe("discounts", () => {
  it("computes discount in basis points, rounding down", () => {
    expect(discountBasisPoints(paise(7_500), paise(10_000))).toBe(2_500);
    expect(discountBasisPoints(paise(6_667), paise(10_000))).toBe(3_333);
    expect(discountBasisPoints(paise(1), paise(3))).toBe(6_666);
  });
  it("returns 0 for missing or non-genuine MRP", () => {
    expect(discountBasisPoints(paise(100), null)).toBe(0);
    expect(discountBasisPoints(paise(100), paise(100))).toBe(0);
    expect(discountBasisPoints(paise(100), paise(50))).toBe(0);
  });
  it("computes savings", () => {
    expect(savingsPaise(paise(7_500), paise(10_000))).toBe(2_500);
    expect(savingsPaise(paise(7_500), undefined)).toBe(0);
  });
  it("formats basis points", () => {
    expect(formatBasisPoints(2_500)).toBe("25%");
    expect(formatBasisPoints(3_333)).toBe("33.33%");
    expect(formatBasisPoints(5)).toBe("0.05%");
  });
});

describe("formatPaise", () => {
  it("uses Indian digit grouping", () => {
    expect(formatPaise(12_499_900)).toBe("₹1,24,999");
    expect(formatPaise(49_950)).toBe("₹499.5");
  });
});

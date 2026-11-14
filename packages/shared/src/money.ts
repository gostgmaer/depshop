/**
 * All monetary values in DealMind are integer paise (1 INR = 100 paise).
 * Never use floating point for money. These helpers are the only sanctioned
 * conversion points between human-readable rupee strings and paise.
 */

declare const PaiseBrand: unique symbol;
export type Paise = number & { readonly [PaiseBrand]: true };

export const PAISE_PER_RUPEE = 100;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/** Validates and brands an integer paise amount. */
export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Paise must be a safe integer, received ${value}`);
  }
  if (value < 0) {
    throw new MoneyError(`Paise must be non-negative, received ${value}`);
  }
  return value as Paise;
}

/**
 * Parses a rupee amount as written on Indian shopping sites, e.g.
 * "₹1,24,999.00", "Rs. 499", "1299.5". Parsing is string-based so no
 * floating-point rounding is ever introduced.
 */
export function parseRupeesToPaise(input: string): Paise {
  const cleaned = input
    .trim()
    .replace(/^(₹|rs\.?|inr)\s*/i, "")
    .replace(/,/g, "")
    .trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new MoneyError(`Unparseable rupee amount: "${input}"`);
  }
  const rupees = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return paise(Number(rupees) * PAISE_PER_RUPEE + Number(fraction));
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * Formats paise for display using Indian digit grouping (₹1,24,999).
 * Conversion to a fractional number happens only here, at the display edge.
 */
export function formatPaise(amount: Paise | number): string {
  const whole = Math.trunc(amount / PAISE_PER_RUPEE);
  const fraction = amount % PAISE_PER_RUPEE;
  return inrFormatter.format(whole + fraction / PAISE_PER_RUPEE);
}

/** Basis points: 1 bp = 0.01%, 10_000 bp = 100%. Integer-only discount math. */
export type BasisPoints = number;

/**
 * Discount of `price` relative to `mrp` in basis points, rounded down so a
 * discount is never overstated. Returns 0 when there is no genuine discount
 * (missing MRP, or MRP <= price).
 */
export function discountBasisPoints(price: Paise, mrp: Paise | null | undefined): BasisPoints {
  if (mrp == null || mrp <= 0 || mrp <= price) return 0;
  return Math.floor(((mrp - price) * 10_000) / mrp);
}

export function savingsPaise(price: Paise, mrp: Paise | null | undefined): Paise {
  if (mrp == null || mrp <= price) return paise(0);
  return paise(mrp - price);
}

export function formatBasisPoints(bp: BasisPoints): string {
  const whole = Math.trunc(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
}

/**
 * Converts a database BIGINT paise value to a JSON-safe paise number.
 * Throws instead of silently losing precision (> 2^53 paise is ~₹90 lakh crore).
 */
export function paiseFromDb(value: bigint | number): Paise {
  if (typeof value === "number") return paise(value);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
    throw new MoneyError(`Paise value out of safe range: ${value}`);
  }
  return paise(Number(value));
}

export function paiseFromDbOrNull(value: bigint | number | null | undefined): Paise | null {
  return value == null ? null : paiseFromDb(value);
}

/**
 * Model numbers and manufacturer part numbers. Both are compared by their
 * alphanumeric key ("SM-S931B/DS" → "SMS931BDS"). A model number names a
 * product line member (several configurations); an MPN names one
 * configuration, so it identifies a variant.
 */
import { modelKey } from "@dealmind/catalog";

export { modelKey };

/** MPN comparison key (same canonical form as model keys). */
export const mpnKey = modelKey;

/** Brand-scoped model fingerprint, as stored in Product.fingerprint. */
export function modelFingerprint(
  brandKey: string,
  model: string | null | undefined,
): string | null {
  const key = modelKey(model);
  return key ? `${brandKey}:${key}` : null;
}

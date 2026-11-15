/**
 * Variant validation: which existing variant (if any) of a candidate product
 * an incoming listing is. RAM/storage/capacity/size never merge when they
 * differ; a colour that only shares a family ("Navy" vs "Blue") is ambiguous;
 * a listing that doesn't state an attribute the product's variants differ on
 * can't be placed. Ambiguity always means manual review, never a guess.
 */
import {
  type AttributeComparison,
  type CategoryProfile,
  compareSpecs,
} from "../normalizers/specifications.js";
import type { VariantSubject } from "../subject.js";

export type VariantRelation =
  | { relation: "SAME_VARIANT"; variantId: string; comparisons: AttributeComparison[] }
  | { relation: "NEW_VARIANT"; comparisons: AttributeComparison[] }
  | {
      relation: "AMBIGUOUS";
      reason: string;
      variantId?: string;
      comparisons: AttributeComparison[];
    };

function variantOnly(profile: CategoryProfile): CategoryProfile {
  return { ...profile, product: [] };
}

export function matchVariant(
  listing: VariantSubject,
  variants: VariantSubject[],
  profile: CategoryProfile,
  pinnedVariantId?: string,
): VariantRelation {
  const vp = variantOnly(profile);
  if (pinnedVariantId) {
    // An identifier/MPN pinned the variant: its attributes must not contradict the listing.
    const pinned = variants.find((v) => v.id === pinnedVariantId);
    const cmp = pinned ? compareSpecs(listing.attributes, pinned.attributes, vp) : [];
    const differs = cmp.filter((c) => c.relation === "different");
    if (differs.length) {
      return {
        relation: "AMBIGUOUS",
        reason: `identifier matches a variant whose ${differs.map((d) => d.attribute).join(", ")} differ`,
        variantId: pinnedVariantId,
        comparisons: cmp,
      };
    }
    return { relation: "SAME_VARIANT", variantId: pinnedVariantId, comparisons: cmp };
  }

  const exact: { v: VariantSubject; cmp: AttributeComparison[] }[] = [];
  const family: { v: VariantSubject; cmp: AttributeComparison[] }[] = [];
  for (const v of variants) {
    const cmp = compareSpecs(listing.attributes, v.attributes, vp);
    if (cmp.some((c) => c.relation === "different")) continue;
    // Every variant attribute either side states must be stated by both.
    const keys = vp.variant.filter(
      (k) => listing.attributes[k] !== undefined || v.attributes[k] !== undefined,
    );
    const covered = keys.every(
      (k) => listing.attributes[k] !== undefined && v.attributes[k] !== undefined,
    );
    if (!covered) continue;
    if (cmp.some((c) => c.relation === "family")) family.push({ v, cmp });
    else exact.push({ v, cmp });
  }
  if (exact.length === 1)
    return { relation: "SAME_VARIANT", variantId: exact[0]!.v.id!, comparisons: exact[0]!.cmp };
  if (exact.length > 1)
    return {
      relation: "AMBIGUOUS",
      reason: "several existing variants match",
      comparisons: exact[0]!.cmp,
    };
  if (family.length) {
    const c = family[0]!.cmp.find((x) => x.relation === "family")!;
    return {
      relation: "AMBIGUOUS",
      reason: `colour "${String(c.a)}" vs "${String(c.b)}" share a family but not a name`,
      variantId: family[0]!.v.id!,
      comparisons: family[0]!.cmp,
    };
  }
  // No existing variant fits. If the listing omits an attribute that the
  // product's variants are distinguished by, we can't say it's a new variant.
  const unstated = vp.variant.filter(
    (k) =>
      listing.attributes[k] === undefined &&
      new Set(variants.map((v) => String(v.attributes[k] ?? ""))).size > 1,
  );
  if (unstated.length) {
    return {
      relation: "AMBIGUOUS",
      reason: `listing doesn't state ${unstated.join(", ")}`,
      comparisons: [],
    };
  }
  if (variants.length && !vp.variant.some((k) => listing.attributes[k] !== undefined)) {
    return {
      relation: "AMBIGUOUS",
      reason: "listing states no variant attributes",
      comparisons: [],
    };
  }
  return { relation: "NEW_VARIANT", comparisons: [] };
}

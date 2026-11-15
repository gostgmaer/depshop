/**
 * Accuracy on the labelled dataset (pure scoring; no database).
 * The hard requirement is ZERO dangerous false positives:
 *   - a DIFFERENT_PRODUCT pair is never auto-merged;
 *   - a SAME_PRODUCT pair (different variant) is never placed in the same variant.
 * Misses (sending a true match to review, or not matching) are acceptable and reported.
 */
import { describe, expect, it } from "vitest";
import { scorePair } from "../scoring/score.js";
import { type Subject, titleSubject } from "../subject.js";
import { LABELED_PAIRS, type Side } from "./labeled-pairs.js";

function side(s: Side, category: string): Subject {
  return titleSubject(s.title, s.brand, {
    category,
    ...(s.model ? { model: s.model } : {}),
    ...(s.mpn ? { mpn: s.mpn } : {}),
    ...(s.barcode ? { barcode: s.barcode } : {}),
    ...(s.attributes ? { attributes: s.attributes } : {}),
  });
}

/** B plays the catalog product with one existing variant. */
function asProduct(s: Subject): Subject {
  return {
    ...s,
    productId: "product-b",
    variants: s.variants.map((v) => ({ ...v, id: "variant-b" })),
  };
}

export function evaluate() {
  return LABELED_PAIRS.map((p) => {
    const r = scorePair(side(p.a, p.category), asProduct(side(p.b, p.category)));
    return {
      pair: p,
      result: r,
      sameVariant: r.decision === "AUTO_MERGE" && r.variant?.relation === "SAME_VARIANT",
    };
  });
}

describe("labelled matching dataset", () => {
  const rows = evaluate();

  it("has no dangerous false positives", () => {
    const falseMerges = rows.filter(
      (r) => r.pair.label === "DIFFERENT_PRODUCT" && r.result.decision === "AUTO_MERGE",
    );
    // Variant placement only takes effect when a pair is merged.
    const wrongVariant = rows.filter(
      (r) =>
        r.pair.label !== "SAME_VARIANT" &&
        r.result.decision === "AUTO_MERGE" &&
        r.result.variant?.relation === "SAME_VARIANT",
    );
    expect(falseMerges.map((r) => `${r.pair.id}: ${r.pair.note}`)).toEqual([]);
    expect(wrongVariant.map((r) => `${r.pair.id}: ${r.pair.note}`)).toEqual([]);
  });

  it("rejects different RAM, storage, generation, line, size, capacity and rating outright or holds them", () => {
    for (const id of [
      "p07",

      "p16",
      "l02",
      "l04",
      "l05",
      "l06",
      "t02",
      "t03",
      "a01",
      "a02",
      "a03",
      "a05",
      "x01",
      "x02",
      "x03",
      "p19",
    ]) {
      const r = rows.find((x) => x.pair.id === id)!;
      expect(r.result.decision, `${id} ${r.pair.note}`).toBe("NO_MATCH");
      expect(
        r.result.conflicts.some((c) => c.severity === "hard"),
        id,
      ).toBe(true);
    }
    // Line qualifiers present on one side only are never auto-merged.
    for (const id of ["p05", "p06", "p08", "p09", "p10", "p13", "p14", "p22"]) {
      expect(rows.find((x) => x.pair.id === id)!.result.decision, id).not.toBe("AUTO_MERGE");
    }
    // Different RAM/storage/colour/size of the same product → a different variant.
    for (const id of ["p03", "p04", "p11", "p12", "p23", "l03", "f01"]) {
      const r = rows.find((x) => x.pair.id === id)!;
      expect(r.result.variant?.relation, `${id} ${r.pair.note}`).not.toBe("SAME_VARIANT");
    }
  });

  it("matches identifiers, MPNs and model numbers with very high/high confidence", () => {
    const byId = (id: string) => rows.find((x) => x.pair.id === id)!.result;
    expect(byId("p17")).toMatchObject({
      method: "IDENTIFIER",
      decision: "AUTO_MERGE",
      confidence: "VERY_HIGH",
    });
    expect(byId("p18")).toMatchObject({
      method: "MPN",
      decision: "AUTO_MERGE",
      confidence: "VERY_HIGH",
    });
    expect(byId("p15")).toMatchObject({ method: "MODEL_NUMBER", decision: "AUTO_MERGE" });
    expect(byId("t01")).toMatchObject({ method: "MODEL_NUMBER", decision: "AUTO_MERGE" });
    expect(byId("a04")).toMatchObject({ method: "MODEL_NUMBER", decision: "AUTO_MERGE" });
  });

  it("sends the colour-family-only pair (Navy vs Blue) to manual review, never merges it silently", () => {
    const r = rows.find((x) => x.pair.id === "p01")!.result;
    expect(r.decision).toBe("MANUAL_REVIEW");
    expect(r.conflicts.some((c) => c.attribute === "color")).toBe(true);
  });

  it("normalizes colour spelling and word order", () => {
    for (const id of ["p20", "p21"]) {
      const r = rows.find((x) => x.pair.id === id)!;
      expect(r.result.variant?.relation, id).toBe("SAME_VARIANT");
    }
  });

  it("reports precision/recall (printed for the benchmark report)", () => {
    const tp = rows.filter((r) => r.pair.label === "SAME_VARIANT" && r.sameVariant).length;
    const fp = rows.filter((r) => r.pair.label !== "SAME_VARIANT" && r.sameVariant).length;
    const positives = rows.filter((r) => r.pair.label === "SAME_VARIANT").length;
    const reviewed = rows.filter((r) => r.result.decision === "MANUAL_REVIEW").length;
    const productLevelFp = rows.filter(
      (r) => r.pair.label === "DIFFERENT_PRODUCT" && r.result.decision === "AUTO_MERGE",
    ).length;
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = positives ? tp / positives : 0;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        pairs: rows.length,
        autoSameVariantPrecision: precision,
        autoSameVariantRecall: recall,
        sentToReview: reviewed,
        productLevelFalsePositives: productLevelFp,
      }),
    );
    expect(precision).toBe(1);
    expect(productLevelFp).toBe(0);
    expect(recall).toBeGreaterThanOrEqual(0.5);
  });
});

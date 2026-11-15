/** Product identifiers: GTIN-8/12/13/14 with check digits, equivalence forms, canonical URLs. */
export { canonicalUrl, classifyBarcode, identifierForms } from "@dealmind/catalog";
export type { Identifiers } from "@dealmind/catalog";

/** Every equivalent identifier string (for variant gtin / product gtin|ean|upc lookups). */
export function allIdentifierForms(forms: {
  gtin: string[];
  ean: string[];
  upc: string[];
}): string[] {
  return [...new Set([...forms.gtin, ...forms.ean, ...forms.upc])];
}

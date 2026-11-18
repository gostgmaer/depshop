# Category intelligence

How a category's attributes, variants, matching rules and filters are defined, and how to add a category. Electronics (phones, laptops, TVs) and large appliances are the deeply covered categories. Others exist in the catalog with generic handling.

**No category specification is invented here.** A category gets specific rules only when its attributes are stated by marketplaces in their listings and confirmed in the labelled tests.

## Where category knowledge lives today

| Concern                                                                                            | Location                                                                       | Per-category?                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Category tree (24 leaf categories)                                                                 | `packages/db/src/seed-data.ts` → `Category`                                    | yes                                         |
| Attribute normalisation (RAM, storage, capacity, size, colour, display, processor, energy rating)  | `packages/catalog/src/normalize.ts`, `matching/normalizers/specifications.ts`  | shared                                      |
| **Matching profile:** which attributes mean "different product" and which mean "different variant" | `PROFILES` + `CATEGORY_TO_PROFILE` in `matching/normalizers/specifications.ts` | yes, 6 profiles                             |
| Query understanding: category words, spec patterns                                                 | `apps/agent/app/providers/rules.py` (`CATEGORY_WORDS`, `_find_specs`)          | partly                                      |
| Hard filters and ranking                                                                           | `ranking/filters/hard-filters.ts`, `ranking/engine.ts`                         | shared (spec filters are generic key/value) |

### Matching profiles (implemented)

| Profile   | Categories                                                        | Product-defining (never merged when different)                                      | Variant-defining                                                                 |
| --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| phone     | smartphones, tablets, wearables                                   | connectivity, processor, model year                                                 | RAM, storage, colour                                                             |
| laptop    | laptops                                                           | processor, GPU, display size, model year                                            | RAM, storage, colour                                                             |
| tv        | televisions                                                       | display size, resolution, panel, model year                                         | colour                                                                           |
| appliance | refrigerators, washing machines, ACs, kitchen and home appliances | capacity (L / kg / ton), energy rating, model year                                  | colour                                                                           |
| apparel   | footwear, men's and women's clothing, fashion                     | —                                                                                   | size, colour                                                                     |
| default   | everything else                                                   | processor, GPU, display, resolution, panel, energy rating, model year, connectivity | RAM, storage, capacities, size, colour (strict: every identity attribute counts) |

## Adding a category (configuration first)

1. Add the category to `seed-data.ts`. The reference seed is idempotent.
2. Map it to an existing matching profile in `CATEGORY_TO_PROFILE`, or add a profile, but **only** with attributes that marketplaces actually state for that category.
3. Add its words to `CATEGORY_WORDS` (whole-word matching) and any new spec pattern to `_find_specs`.
4. Add at least five labelled pairs to `labeled-pairs.ts` (including a different-variant pair that must not merge) and five queries to `evals/search_queries.jsonl`.
5. The gates must still pass: matching precision 1.0, and holdout exact match no lower than before.

## Gaps (recommended, not implemented)

- **No single per-category config object:** profiles, query words and spec patterns live in three files. Consolidating them is worth doing **when the third new category is added**, not before; today it would be a refactor without a measured benefit.
- **Required vs. optional specs per category, and category-specific comparison rows,** aren't modelled. The compare view shows the attributes both offers state.
- **Category-specific ranking signals** (e.g. energy rating for appliances in best value) aren't implemented. They need real result sets to validate their weights.
- **Spec ranges** ("at least 300L") are captured as an exact value. The spec model has no min/max; recorded in [search-quality-evaluation.md](search-quality-evaluation.md).

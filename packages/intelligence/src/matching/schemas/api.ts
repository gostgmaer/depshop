/** Zod schemas of the internal matching API. */
import { sourceListingSchema } from "@dealmind/catalog";
import { z } from "zod";

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);
const uuid = z.string().uuid();

export const matchRequestSchema = z
  .object({
    /** Source slug the listing comes from (optional; enables queuing a review). */
    sourceId: slug.optional(),
    /** The listing, in the catalog's source-listing contract. */
    listing: sourceListingSchema,
  })
  .strict();
export type MatchRequest = z.input<typeof matchRequestSchema>;

export const matchBatchSchema = z
  .object({ items: z.array(matchRequestSchema).min(1).max(100) })
  .strict();

export const reviewRequestSchema = z
  .object({
    resolution: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("match"),
          productId: uuid,
          variantId: uuid.optional(),
          newVariant: z.boolean().optional(),
        })
        .strict(),
      z.object({ action: z.literal("create") }).strict(),
      z.object({ action: z.literal("reject") }).strict(),
      z.object({ action: z.literal("merge"), keepProductId: uuid }).strict(),
    ]),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

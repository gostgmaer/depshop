/**
 * Response helpers.
 *
 * Handlers return plain data (or `paginated(...)`); the envelope plugin wraps
 * it as `{ success, data, meta: { requestId, pagination? } }` in
 * preSerialization, before the response schema is applied.
 *
 * `ok(schema)` / `page(item)` therefore return the REAL envelope schema at
 * runtime, so serialization is validated against the true wire shape and the
 * OpenAPI docs show the envelope. For TypeScript they are typed as the inner
 * data (what handlers actually return). This cast is the only place where the
 * static and runtime shapes differ, by design.
 */
import { type PaginationMeta, envelope, pagedEnvelope } from "@dealmind/shared";
import type { z } from "zod";

/** Marker for list endpoints: items go to `data`, pagination to `meta`. */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly pagination: PaginationMeta,
  ) {}
}

export function paginated<T>(items: T[], pagination: PaginationMeta): Paginated<T> {
  return new Paginated(items, pagination);
}

/** Response schema for a single resource (enveloped on the wire). */
export function ok<T extends z.ZodTypeAny>(data: T): T {
  return envelope(data) as unknown as T;
}

/** Response schema for a page of resources (enveloped on the wire). */
export function page<T extends z.ZodTypeAny>(item: T): z.ZodType<Paginated<z.infer<T>>> {
  return pagedEnvelope(item) as unknown as z.ZodType<Paginated<z.infer<T>>>;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

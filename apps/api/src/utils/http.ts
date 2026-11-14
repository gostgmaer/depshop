/**
 * Response helpers. Handlers return plain data (or `paginated(...)`); the
 * envelope plugin wraps it as `{ success, data, meta: { requestId, ... } }`.
 * Route response schemas use `ok(...)` / `page(...)` so the documented and
 * serialized shapes always match the envelope.
 */
import { type PaginationMeta, envelope, pagedEnvelope } from "@dealmind/shared";

export { envelope as ok, pagedEnvelope as page };

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

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

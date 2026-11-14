/**
 * API response envelope and pagination contracts.
 *
 *   success: { success: true,  data, meta: { requestId, pagination? } }
 *   error:   { success: false, error: { code, message, details? }, meta: { requestId } }
 */
import { z } from "zod";

export const paginationMeta = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type PaginationMeta = z.infer<typeof paginationMeta>;

export const responseMeta = z.object({
  requestId: z.string(),
  pagination: paginationMeta.optional(),
});

/** Envelope schema for a single resource. */
export function envelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({ success: z.literal(true), data, meta: responseMeta });
}

/** Envelope schema for a page of resources (pagination required in meta). */
export function pagedEnvelope<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    success: z.literal(true),
    data: z.array(item),
    meta: responseMeta.extend({ pagination: paginationMeta }),
  });
}

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta: { requestId: string; pagination?: PaginationMeta };
}

/** Standard page query: ?page=1&pageSize=20 (pageSize capped at 100). */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

export function paginationOf(q: PageQuery, total: number): PaginationMeta {
  return { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) };
}

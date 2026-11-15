import type { Prisma, PrismaClient } from "@dealmind/db";

export type Db = PrismaClient | Prisma.TransactionClient;

/** A candidate product found by one matcher (scored later by scorePair). */
export interface CandidateHit {
  productId: string;
  matcher: "gtin" | "mpn" | "model" | "title" | "fuzzy" | "semantic";
  /** pg_trgm or cosine similarity when the matcher computes one. */
  similarity?: number;
}

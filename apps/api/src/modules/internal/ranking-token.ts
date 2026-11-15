/**
 * Ranking provenance. `POST /internal/v1/intelligence/ranking/rank` returns a
 * token signed with a key ONLY this API holds (derived from SESSION_SECRET;
 * the agent never has it). When the agent persists results, every ranked deal
 * must match the signed ranking: same offers in the same order, same scores
 * (truncation to the top N is allowed). So the agent orchestrates, but rank
 * and score always come from the deterministic TypeScript engine.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface RankingTokenPayload {
  /** [offerId, rank, score] in rank order. */
  deals: [string, number, number][];
  mode: string;
  exp: number;
}

export const RANKING_TOKEN_TTL_SECONDS = 3_600;

export function rankingKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update("dealmind:ranking-token:v1").digest();
}

export function signRankingToken(payload: RankingTokenPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function verifyRankingToken(
  token: string,
  key: Buffer,
  nowSeconds = Date.now() / 1000,
): RankingTokenPayload | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<RankingTokenPayload>;
    if (!Array.isArray(p.deals) || typeof p.mode !== "string" || typeof p.exp !== "number")
      return null;
    if (p.exp < nowSeconds) return null;
    return p as RankingTokenPayload;
  } catch {
    return null;
  }
}

/** True when `deals` is exactly a prefix of the signed ranking (offer, rank and score). */
export function matchesRanking(
  deals: { offerId: string; rank: number; score: number }[],
  signed: RankingTokenPayload,
): boolean {
  if (deals.length > signed.deals.length) return false;
  const sorted = [...deals].sort((a, b) => a.rank - b.rank);
  return sorted.every((d, i) => {
    const s = signed.deals[i]!;
    return s[0] === d.offerId && s[1] === d.rank && s[2] === d.score;
  });
}

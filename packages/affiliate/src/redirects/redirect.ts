/**
 * The outbound click: offer id → validated marketplace URL (+ affiliate tag)
 * and a click record. The destination is only ever the offer's stored URL;
 * a failed validation is recorded as BLOCKED and never redirected.
 *
 * Privacy: the user id is kept only for signed-in users; the IP address is
 * stored as a salted hash, the user agent as a coarse device class, the
 * referrer as a host. These are cleared after the retention window.
 * A repeat click by the same visitor on the same offer within the dedupe
 * window still redirects but isn't counted again.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { PrismaClient } from "@dealmind/db";
import { deviceClass, referrerHost, validateDestination } from "../links/destination.js";
import type { AffiliateRegistry } from "../providers/registry.js";

export const SURFACES = ["product", "search", "compare", "watchlist", "alert"] as const;
export type Surface = (typeof SURFACES)[number];

export interface ClickRequest {
  offerId: string;
  userId: string | null;
  surface: Surface | null;
  ip: string | null;
  userAgent: string | undefined;
  referrer: string | undefined;
}

export type RedirectResult =
  | {
      status: "redirect";
      url: string;
      clickId: string | null;
      duplicate: boolean;
      provider: string;
    }
  | { status: "not-found" }
  /** A sample (fictional) store: there is no real listing to visit. */
  | { status: "sample" }
  | { status: "blocked"; reason: string };

export interface RedirectDeps {
  prisma: PrismaClient;
  registry: AffiliateRegistry;
  /** Salt for IP hashing (server secret). */
  ipSalt: string;
  /** Returns true the first time a key is seen within ttlSeconds (e.g. Redis SET NX EX). */
  firstSeen?: (key: string, ttlSeconds: number) => Promise<boolean>;
  dedupeSeconds?: number;
  now?: () => Date;
}

export const hashIp = (salt: string, ip: string) =>
  createHmac("sha256", salt).update(ip).digest("base64url").slice(0, 32);

export async function resolveClick(deps: RedirectDeps, req: ClickRequest): Promise<RedirectResult> {
  const offer = await deps.prisma.productOffer.findUnique({
    where: { id: req.offerId },
    select: {
      id: true,
      productId: true,
      variantId: true,
      productUrl: true,
      source: {
        select: {
          id: true,
          slug: true,
          name: true,
          domain: true,
          affiliateEnabled: true,
          isSample: true,
        },
      },
    },
  });
  if (!offer) return { status: "not-found" };
  if (offer.source.isSample) return { status: "sample" };

  const provider = deps.registry.forLinks(offer.source);
  const check = validateDestination(offer.productUrl, provider.allowedHosts, offer.source.domain);
  const ipHash = req.ip ? hashIp(deps.ipSalt, req.ip) : null;
  const base = {
    userId: req.userId,
    offerId: offer.id,
    sourceId: offer.source.id,
    productId: offer.productId,
    variantId: offer.variantId,
    surface: req.surface,
    referrerDomain: referrerHost(req.referrer),
    ipHash,
    userAgent: deviceClass(req.userAgent),
    createdAt: (deps.now ?? (() => new Date()))(),
  };
  if (!check.ok) {
    await deps.prisma.affiliateClick.create({
      data: {
        ...base,
        clickRef: randomBytes(12).toString("base64url"),
        provider: provider.id,
        destinationDomain: (() => {
          try {
            return new URL(offer.productUrl).hostname.slice(0, 253);
          } catch {
            return "";
          }
        })(),
        redirectStatus: "BLOCKED",
      },
    });
    return { status: "blocked", reason: check.reason };
  }

  // Same visitor, same offer, within the window: redirect without counting again.
  const visitor = req.userId ?? ipHash ?? null;
  const fresh =
    visitor && deps.firstSeen
      ? await deps.firstSeen(`affclick:${offer.id}:${visitor}`, deps.dedupeSeconds ?? 30)
      : true;
  const clickRef = randomBytes(12).toString("base64url");
  const link = provider.link(check.url, { clickRef });
  if (!fresh)
    return {
      status: "redirect",
      url: link.url,
      clickId: null,
      duplicate: true,
      provider: provider.id,
    };
  const click = await deps.prisma.affiliateClick.create({
    data: {
      ...base,
      clickRef,
      provider: provider.id,
      trackingId: link.trackingId,
      destinationDomain: check.url.hostname,
      redirectStatus: "REDIRECTED",
    },
    select: { id: true },
  });
  return {
    status: "redirect",
    url: link.url,
    clickId: click.id,
    duplicate: false,
    provider: provider.id,
  };
}

/** Retention: clear identifiers after `anonymizeAfterDays`, delete unconverted clicks after `deleteAfterDays`. */
export async function applyClickRetention(
  prisma: PrismaClient,
  now: Date,
  opts: { anonymizeAfterDays?: number; deleteAfterDays?: number } = {},
): Promise<{ anonymized: number; deleted: number }> {
  const DAY = 86_400_000;
  const anonymized = await prisma.affiliateClick.updateMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - (opts.anonymizeAfterDays ?? 30) * DAY) },
      OR: [
        { ipHash: { not: null } },
        { userAgent: { not: null } },
        { referrerDomain: { not: null } },
      ],
    },
    data: { ipHash: null, userAgent: null, referrerDomain: null },
  });
  const deleted = await prisma.affiliateClick.deleteMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - (opts.deleteAfterDays ?? 395) * DAY) },
      conversions: { none: {} },
    },
  });
  return { anonymized: anonymized.count, deleted: deleted.count };
}

/**
 * Guest search: a visitor can search without an account.
 *
 * A guest is a User row with `isGuest = true`: a random identity that isn't linked to
 * the IAM, with an undeliverable `@guest.dealmind.invalid` address. That way every
 * existing ownership rule (searches belong to a user), plan limit, cascade and retention
 * rule applies unchanged.
 *
 * The guest's credential is a separate HttpOnly cookie holding `<userId>.<HMAC>`
 * (HMAC-SHA256 with SESSION_SECRET). It is honoured ONLY by routes that opt in with
 * `allowGuest` / `ensureGuest` (search). `requireAuth`, so every account feature
 * (watchlists, alerts, notifications, billing, settings, admin), never accepts it.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@dealmind/db";
import type { AuthContext } from "./session-service.js";

export const GUEST_EMAIL_DOMAIN = "guest.dealmind.invalid";
/** How long the guest cookie lives (searches themselves follow the normal retention). */
export const GUEST_COOKIE_DAYS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GuestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secret: string,
  ) {}

  private mac(userId: string): string {
    return createHmac("sha256", this.secret).update(`dealmind-guest:${userId}`).digest("base64url");
  }

  sign(userId: string): string {
    return `${userId}.${this.mac(userId)}`;
  }

  /** The guest user id in a cookie value, or null when it isn't a valid signature. */
  verify(token: string | undefined): string | null {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const userId = token.slice(0, dot);
    if (!UUID.test(userId)) return null;
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.mac(userId));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return userId;
  }

  /** Resolves a guest cookie to an identity (the user must still exist, be a guest and be active). */
  async resolve(token: string | undefined): Promise<AuthContext | null> {
    const userId = this.verify(token);
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isGuest: true, status: true },
    });
    if (!user?.isGuest || user.status !== "ACTIVE") return null;
    return guestContext(user.id);
  }

  async create(): Promise<{ auth: AuthContext; token: string }> {
    const id = randomUUID();
    const user = await this.prisma.user.create({
      data: {
        id,
        iamUserId: randomUUID(), // unique placeholder: a guest has no IAM identity
        email: `guest-${id}@${GUEST_EMAIL_DOMAIN}`,
        name: "Guest",
        isGuest: true,
        preference: { create: {} },
      },
      select: { id: true },
    });
    return { auth: guestContext(user.id), token: this.sign(user.id) };
  }
}

export function guestContext(userId: string): AuthContext {
  return { sessionId: `guest:${userId}`, userId, role: "USER", emailVerified: false, guest: true };
}

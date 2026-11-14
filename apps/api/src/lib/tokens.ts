import { createHash, randomBytes } from "node:crypto";
import { UserRole } from "@dealmind/shared";
import { SignJWT, jwtVerify } from "jose";

const ISSUER = "dealmind";
const AUDIENCE = "dealmind-api";

export interface AccessClaims {
  userId: string;
  role: UserRole;
}

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    readonly accessTtlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ role: claims.role, typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
  }

  /** Returns the verified claims or null for any invalid/expired token. */
  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      const role = UserRole.safeParse(payload.role);
      if (payload.typ !== "access" || !payload.sub || !role.success) return null;
      return { userId: payload.sub, role: role.data };
    } catch {
      return null;
    }
  }
}

/** Opaque refresh token: 256 bits of randomness, base64url. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

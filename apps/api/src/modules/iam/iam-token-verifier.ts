/**
 * Verifies IAM access tokens (RS256) against the IAM's published keys.
 *
 * The IAM serves its JWKS inside its standard response envelope
 * (`{ success, data: { keys } }`) rather than as a bare JWK Set, so jose's
 * createRemoteJWKSet cannot read it directly. This fetches and unwraps the
 * key set, caches it, and refetches (rate-limited) when an unknown key id
 * appears, which handles key rotation.
 */
import { type JSONWebKeySet, type JWTPayload, createLocalJWKSet, jwtVerify } from "jose";

export interface IamClaims {
  /** IAM user id. */
  sub: string;
  email: string;
  sessionId: string | null;
  isEmailVerified: boolean;
  expiresAt: Date;
}

export interface IamTokenVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  timeoutMs: number;
  /** How long a fetched key set is trusted before refreshing (ms). */
  cacheTtlMs?: number;
  /** Minimum gap between refetches triggered by unknown key ids (ms). */
  minRefetchIntervalMs?: number;
  fetch?: typeof fetch;
}

export class IamTokenVerifier {
  private keys: ReturnType<typeof createLocalJWKSet> | null = null;
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: IamTokenVerifierOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async loadKeys(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const res = await this.fetchImpl(this.opts.jwksUrl, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
        const body = (await res.json()) as { keys?: unknown; data?: { keys?: unknown } };
        const keys = (body.data?.keys ?? body.keys) as JSONWebKeySet["keys"] | undefined;
        if (!Array.isArray(keys) || keys.length === 0)
          throw new Error("JWKS response contains no keys");
        this.keys = createLocalJWKSet({ keys });
        this.fetchedAt = Date.now();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async keySet() {
    if (!this.keys || Date.now() - this.fetchedAt > (this.opts.cacheTtlMs ?? 10 * 60_000)) {
      await this.loadKeys();
    }
    return this.keys as NonNullable<typeof this.keys>;
  }

  /** Returns verified claims, or throws if the token is invalid/expired/foreign. */
  async verify(token: string): Promise<IamClaims> {
    const options = {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: ["RS256"],
    };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await this.keySet(), options));
    } catch (err) {
      const code = (err as { code?: string }).code;
      const recentlyFetched =
        Date.now() - this.fetchedAt < (this.opts.minRefetchIntervalMs ?? 30_000);
      if (code !== "ERR_JWKS_NO_MATCHING_KEY" || recentlyFetched) throw err;
      await this.loadKeys(); // possible key rotation
      ({ payload } = await jwtVerify(token, await this.keySet(), options));
    }

    if (
      payload.type !== "access" ||
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string"
    ) {
      throw new Error("Not an IAM user access token");
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
      isEmailVerified: payload.isEmailVerified === true,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
  }

  async health(): Promise<void> {
    await this.loadKeys();
  }
}

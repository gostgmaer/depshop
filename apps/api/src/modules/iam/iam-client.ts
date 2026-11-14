/**
 * HTTP client for the shared EasyDev IAM (multi-tannet-auth-services).
 *
 * Covers only the endpoints DealMind uses, with the request/response shapes
 * verified against the running IAM. Every IAM response is wrapped in
 * `{ success, data, message }`; failures carry `{ statusCode, message }`.
 *
 * Security: IAM responses are never forwarded to browsers. The login response
 * in particular contains fields (e.g. passwordHash) that must not leak, so this
 * client returns only the fields DealMind needs.
 */

export interface IamClientOptions {
  /** e.g. http://127.0.0.1:3304/api/v1/iam */
  baseUrl: string;
  /** Sent as x-tenant-id. A config constant only: DealMind has no tenancy. */
  tenant: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Thrown for any non-2xx IAM response or transport failure. */
export class IamError extends Error {
  override readonly name = "IamError";
  constructor(
    /** HTTP status from the IAM, or 0 for network/timeout failures. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** True when the IAM itself is unavailable (network, timeout, 5xx). */
  get unavailable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface IamTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  accessExpiresIn: number;
  /** Seconds. */
  refreshExpiresIn: number;
}

/** The subset of the IAM user DealMind mirrors. */
export interface IamUserProfile {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  isEmailVerified: boolean;
}

export interface IamLoginResult extends IamTokenSet {
  user: IamUserProfile;
}

type Envelope<T> = {
  success?: boolean;
  data?: T;
  message?: string | string[];
  statusCode?: number;
};

function pickProfile(raw: Record<string, unknown>): IamUserProfile {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    id: String(raw.id),
    email: String(raw.email),
    firstName: str(raw.firstName),
    lastName: str(raw.lastName),
    displayName: str(raw.displayName),
    isEmailVerified: raw.isEmailVerified === true,
  };
}

export class IamClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: IamClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    {
      body,
      accessToken,
      clientIp,
    }: { body?: unknown; accessToken?: string; clientIp?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-tenant-id": this.opts.tenant,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    // Lets the IAM's own per-IP throttling see the real client, not DealMind.
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new IamError(0, `IAM ${reason}`);
    }

    const json = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok || json.success === false) {
      const message = Array.isArray(json.message) ? json.message.join("; ") : json.message;
      throw new IamError(res.status, message ?? `IAM responded ${res.status}`);
    }
    return json.data as T;
  }

  async register(input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    clientIp?: string;
  }): Promise<{ userId: string }> {
    // The IAM rejects unknown properties (forbidNonWhitelisted), so send
    // exactly the fields its RegisterDto allows, whatever the caller passes.
    const body = {
      email: input.email,
      password: input.password,
      firstName: input.firstName,
      lastName: input.lastName,
    };
    const data = await this.request<{ userId: string }>("POST", "/auth/register", {
      body,
      clientIp: input.clientIp,
    });
    return { userId: data.userId };
  }

  async login(email: string, password: string, clientIp?: string): Promise<IamLoginResult> {
    const data = await this.request<IamTokenSet & { user: Record<string, unknown> }>(
      "POST",
      "/auth/login",
      {
        body: { email, password },
        clientIp,
      },
    );
    if (!data.accessToken || !data.refreshToken) {
      // e.g. a 2FA challenge instead of tokens: not supported by DealMind yet.
      throw new IamError(403, "Additional verification is required for this account");
    }
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessExpiresIn: data.accessExpiresIn,
      refreshExpiresIn: data.refreshExpiresIn,
      user: pickProfile(data.user),
    };
  }

  async refresh(refreshToken: string): Promise<IamTokenSet> {
    const data = await this.request<IamTokenSet>("POST", "/auth/refresh", {
      body: { refreshToken },
    });
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessExpiresIn: data.accessExpiresIn,
      refreshExpiresIn: data.refreshExpiresIn,
    };
  }

  async me(accessToken: string): Promise<IamUserProfile> {
    return pickProfile(
      await this.request<Record<string, unknown>>("GET", "/auth/me", { accessToken }),
    );
  }

  async logout(accessToken: string): Promise<void> {
    await this.request("POST", "/auth/logout", { accessToken });
  }

  /** Revokes one of the caller's own IAM sessions. */
  async revokeSession(accessToken: string, iamSessionId: string): Promise<void> {
    await this.request("DELETE", `/sessions/${encodeURIComponent(iamSessionId)}`, { accessToken });
  }

  async verifyEmail(token: string): Promise<void> {
    await this.request("POST", "/auth/register/verify", { body: { token } });
  }

  async sendVerification(email: string): Promise<void> {
    await this.request("POST", "/auth/register/send-verification", { body: { email } });
  }

  async forgotPassword(email: string, clientIp?: string): Promise<void> {
    await this.request("POST", "/auth/password/forgot", { body: { email }, clientIp });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.request("POST", "/auth/password/reset", { body: { token, newPassword } });
  }

  async changePassword(
    accessToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.request("POST", "/auth/password/change", {
      accessToken,
      body: { currentPassword, newPassword },
    });
  }

  async updateProfile(
    accessToken: string,
    profile: { firstName: string; lastName: string; displayName: string },
  ): Promise<IamUserProfile> {
    return pickProfile(
      await this.request<Record<string, unknown>>("PATCH", "/profile", {
        accessToken,
        body: profile,
      }),
    );
  }

  async health(): Promise<void> {
    await this.request("GET", "/health");
  }
}

/** DealMind keeps a single display name; the IAM stores first/last names. */
export function splitName(name: string): {
  firstName: string;
  lastName: string;
  displayName: string;
} {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const space = trimmed.indexOf(" ");
  return space === -1
    ? { firstName: trimmed, lastName: "", displayName: trimmed }
    : {
        firstName: trimmed.slice(0, space),
        lastName: trimmed.slice(space + 1),
        displayName: trimmed,
      };
}

export function displayNameOf(user: IamUserProfile): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return user.displayName ?? (full || user.email.split("@")[0] || "DealMind user");
}

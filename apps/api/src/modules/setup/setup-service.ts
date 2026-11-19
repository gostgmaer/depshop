/**
 * First-run admin setup.
 *
 * While no ADMIN account exists, the API holds a one-time setup token (hashed in
 * `PlatformSetup`). Whoever has it (it is printed to the API log at start-up, or set
 * with ADMIN_SETUP_TOKEN) can name the first administrator through /setup: the account
 * is registered in the IAM like any sign-up, and becomes ADMIN on its first sign-in.
 * The token is single-use; once an ADMIN exists, setup is closed for good.
 *
 * Passwords never pass through DealMind's storage: registration and sign-in are the
 * IAM's, including its e-mail verification policy.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@dealmind/db";
import { AppError, ErrorCode, type RegisterInput } from "@dealmind/shared";
import { recordAudit } from "../users/audit.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SetupLogger {
  warn(obj: object, msg: string): void;
}

export class SetupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: {
      /** Operator-provided token (ADMIN_SETUP_TOKEN); otherwise one is generated. */
      configuredToken?: string;
      register: (input: RegisterInput) => Promise<{ existing: boolean }>;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private async adminExists(): Promise<boolean> {
    return (await this.prisma.user.count({ where: { role: "ADMIN", isGuest: false } })) > 0;
  }

  /** True while the first administrator still has to be set up. */
  async required(): Promise<boolean> {
    if (await this.adminExists()) return false;
    const row = await this.prisma.platformSetup.findUnique({ where: { id: 1 } });
    return !row?.completedAt;
  }

  /**
   * At start-up: when setup is still open and unclaimed, make sure a token exists.
   * A generated token is logged once by this instance (it's useless after setup).
   */
  async prepare(log: SetupLogger): Promise<void> {
    if (!(await this.required())) return;
    const row = await this.prisma.platformSetup.findUnique({ where: { id: 1 } });
    // A fresh token on every start while setup is unfinished: if a claim never completed
    // (wrong e-mail, unknown password), the operator can claim again; it replaces the pending one.
    const token = this.opts.configuredToken ?? randomBytes(18).toString("base64url");
    await this.prisma.platformSetup.upsert({
      where: { id: 1 },
      create: { id: 1, setupTokenHash: sha256(token) },
      update: { setupTokenHash: sha256(token) },
    });
    const pending = row?.adminEmail ? { pendingAdminEmail: row.adminEmail } : {};
    if (this.opts.configuredToken) {
      log.warn(
        pending,
        "First-run setup: no administrator yet. Open /setup with ADMIN_SETUP_TOKEN.",
      );
    } else {
      log.warn(
        { ...pending, setupToken: token },
        "First-run setup: no administrator yet. Open /setup and enter this one-time setup token.",
      );
    }
  }

  /** Claims the first-administrator slot for `input.email` (single use). */
  async claim(
    token: string,
    input: RegisterInput,
  ): Promise<{ email: string; existingAccount: boolean }> {
    if (!(await this.required()))
      throw new AppError(ErrorCode.CONFLICT, "Setup is already complete.");
    const row = await this.prisma.platformSetup.findUnique({ where: { id: 1 } });
    const given = Buffer.from(sha256(token));
    const expected = Buffer.from(row?.setupTokenHash ?? "");
    if (
      !row?.setupTokenHash ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    )
      throw AppError.forbidden("That setup token isn't valid.");
    const email = input.email.toLowerCase();
    // Claim atomically: only the request that still sees this exact token wins.
    const claimed = await this.prisma.platformSetup.updateMany({
      where: { id: 1, setupTokenHash: row.setupTokenHash, completedAt: null },
      data: { setupTokenHash: null, adminEmail: email, claimedAt: this.now() },
    });
    if (claimed.count !== 1)
      throw new AppError(ErrorCode.CONFLICT, "Setup was just completed by another request.");
    let existing: boolean;
    try {
      ({ existing } = await this.opts.register({ ...input, email }));
    } catch (err) {
      // Registration failed (e.g. weak password): release the claim so the token works again.
      await this.prisma.platformSetup.update({
        where: { id: 1 },
        data: {
          setupTokenHash: row.setupTokenHash,
          adminEmail: row.adminEmail,
          claimedAt: row.claimedAt,
        },
      });
      throw err;
    }
    // An existing IAM account keeps its own password: the operator must sign in with it.
    return { email, existingAccount: existing };
  }

  /**
   * After a sign-in: if this is the claimed e-mail and there is still no ADMIN, promote
   * the account (once). Returns true when it was promoted.
   */
  async promoteOnSignIn(user: { id: string; email: string }): Promise<boolean> {
    const row = await this.prisma.platformSetup.findUnique({ where: { id: 1 } });
    if (!row?.adminEmail || row.completedAt || row.adminEmail !== user.email.toLowerCase())
      return false;
    if (await this.adminExists()) return false;
    const done = await this.prisma.$transaction(async (tx) => {
      const marked = await tx.platformSetup.updateMany({
        where: { id: 1, completedAt: null, adminEmail: row.adminEmail },
        data: { completedAt: this.now() },
      });
      if (marked.count !== 1) return false;
      await tx.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
      return true;
    });
    if (done)
      await recordAudit(this.prisma, {
        actorId: user.id,
        action: "setup.first_admin",
        entity: "User",
        entityId: user.id,
        metadata: { via: "first-run setup" },
      });
    return done;
  }
}

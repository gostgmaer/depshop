import { randomUUID } from "node:crypto";
import type {
  ListUsersParams,
  NewSession,
  SessionRecord,
  UserRecord,
  UserStatus,
  UserStore,
} from "../modules/users/user-store.js";

/** In-memory UserStore for tests. Mirrors PrismaUserStore semantics. */
export class MemoryUserStore implements UserStore {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();

  findUserByEmail(email: string) {
    return Promise.resolve([...this.users.values()].find((u) => u.email === email) ?? null);
  }
  findUserById(id: string) {
    return Promise.resolve(this.users.get(id) ?? null);
  }
  createUser(input: { email: string; name: string; passwordHash: string }) {
    const user: UserRecord = {
      id: randomUUID(),
      role: "USER",
      status: "ACTIVE",
      createdAt: new Date(),
      ...input,
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }
  recordLogin() {
    return Promise.resolve();
  }
  createSession(input: NewSession) {
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }
  findSessionByTokenHash(tokenHash: string) {
    return Promise.resolve(
      [...this.sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null,
    );
  }
  async rotateSession(oldSessionId: string, next: NewSession) {
    const old = this.sessions.get(oldSessionId);
    if (!old || old.revokedAt) return null;
    old.revokedAt = new Date();
    return this.createSession(next);
  }
  revokeSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s && !s.revokedAt) s.revokedAt = new Date();
    return Promise.resolve();
  }
  revokeSessionFamily(familyId: string) {
    for (const s of this.sessions.values()) if (s.familyId === familyId) s.revokedAt ??= new Date();
    return Promise.resolve();
  }
  revokeAllUserSessions(userId: string) {
    for (const s of this.sessions.values()) if (s.userId === userId) s.revokedAt ??= new Date();
    return Promise.resolve();
  }
  listUsers({ limit }: ListUsersParams) {
    return Promise.resolve({ items: [...this.users.values()].slice(0, limit), nextCursor: null });
  }
  setUserStatus(userId: string, status: UserStatus) {
    const u = this.users.get(userId);
    if (!u) return Promise.resolve(null);
    u.status = status;
    return Promise.resolve(u);
  }
}

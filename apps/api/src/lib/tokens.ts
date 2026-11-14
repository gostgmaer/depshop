import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque secret: 256 bits of CSPRNG output, base64url (43 chars). Used for
 * session cookies and email-link tokens. Only SHA-256 hashes are persisted.
 * A fast hash is appropriate here (unlike passwords): the input has 256 bits
 * of entropy, so brute force is infeasible.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

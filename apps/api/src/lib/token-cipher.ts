import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption (AES-256-GCM) for secrets DealMind must store but
 * never expose, such as the user's IAM refresh token. Format:
 *   v1.<iv base64url>.<auth tag base64url>.<ciphertext base64url>
 * A random 96-bit IV is used per message; tampering fails decryption.
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv, tag, ciphertext]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext, extra] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext || extra !== undefined) {
      throw new Error("Malformed encrypted token");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

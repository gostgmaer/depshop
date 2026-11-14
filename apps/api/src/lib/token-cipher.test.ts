import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher } from "./token-cipher.js";

const key = () => randomBytes(32).toString("base64");

describe("TokenCipher", () => {
  it("round-trips and uses a fresh IV per message", () => {
    const c = new TokenCipher(key());
    const a = c.encrypt("eyJhbGciOi.secret.token");
    const b = c.encrypt("eyJhbGciOi.secret.token");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain("secret");
    expect(c.decrypt(a)).toBe("eyJhbGciOi.secret.token");
  });

  it("rejects tampering, foreign keys, malformed input and bad key sizes", () => {
    const c = new TokenCipher(key());
    const [v, iv, tag, ct = ""] = c.encrypt("value").split(".");
    const flipped = (ct.startsWith("A") ? "B" : "A") + ct.slice(1);
    expect(() => c.decrypt([v, iv, tag, flipped].join("."))).toThrow();
    expect(() => new TokenCipher(key()).decrypt(c.encrypt("value"))).toThrow();
    expect(() => c.decrypt("v2.a.b.c")).toThrow(/Malformed/);
    expect(() => new TokenCipher(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

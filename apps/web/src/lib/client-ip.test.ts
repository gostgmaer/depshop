import { describe, expect, it } from "vitest";
import { trustedClientIp } from "./client-ip";

describe("trustedClientIp", () => {
  it("forwards nothing when Next.js is directly exposed (no trusted proxies)", () => {
    expect(trustedClientIp("203.0.113.9", 0)).toBeUndefined();
    expect(trustedClientIp("::ffff:127.0.0.1", 0)).toBeUndefined();
  });

  it("uses only the hop appended by the outermost trusted proxy", () => {
    // Client spoofed "198.51.100.1"; Traefik appended the real address.
    expect(trustedClientIp("198.51.100.1, 203.0.113.9", 1)).toBe("203.0.113.9");
    expect(trustedClientIp("198.51.100.1, 203.0.113.9, 10.0.0.2", 2)).toBe("203.0.113.9");
  });

  it("rejects missing, too-short and malformed chains", () => {
    expect(trustedClientIp(null, 1)).toBeUndefined();
    expect(trustedClientIp("203.0.113.9", 2)).toBeUndefined();
    expect(trustedClientIp("not an ip<script>", 1)).toBeUndefined();
    expect(trustedClientIp("203.0.113.9", 1.5)).toBeUndefined();
  });
});

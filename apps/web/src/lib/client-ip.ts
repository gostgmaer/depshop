/**
 * Picks the client IP to forward to the API, resistant to X-Forwarded-For
 * spoofing.
 *
 * Next.js passes an incoming X-Forwarded-For header through unchanged, so
 * everything a client sends is attacker-controlled. Only entries appended by
 * trusted reverse proxies in front of Next.js (e.g. Traefik, which discards
 * untrusted forwarding headers) can be believed.
 *
 *  - trustedProxyCount = 0: Next.js is directly exposed; no entry is
 *    trustworthy, so nothing is forwarded (the API then sees the proxy's own
 *    address). Use this only for local development.
 *  - trustedProxyCount = N: the client is the entry appended by the
 *    outermost trusted proxy, i.e. the N-th entry from the right.
 */
export function trustedClientIp(
  forwardedFor: string | null,
  trustedProxyCount: number,
): string | undefined {
  if (!Number.isInteger(trustedProxyCount) || trustedProxyCount <= 0 || !forwardedFor)
    return undefined;
  const hops = forwardedFor
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const ip = hops.at(-trustedProxyCount);
  return ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : undefined;
}

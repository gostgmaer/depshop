/**
 * Content-Security-Policy (Phase 7.1). Nonce-based: Next.js applies the
 * per-request nonce to its own scripts; `strict-dynamic` lets those scripts
 * load the Razorpay checkout script without allowing arbitrary hosts.
 * Styles allow inline (Tailwind/Radix/Recharts set style attributes).
 * Product images come from marketplace CDNs, so images allow any https host.
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "https://checkout.razorpay.com",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", "https://*.razorpay.com", ...(dev ? ["ws:"] : [])],
    "frame-src": ["https://api.razorpay.com", "https://checkout.razorpay.com"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const policy = Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
  return dev ? policy : `${policy}; upgrade-insecure-requests`;
}

/** Static hardening headers for every response (see next.config.ts). */
export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Voice search uses the microphone on this origin only; nothing else is needed.
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

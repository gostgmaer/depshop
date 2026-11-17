/**
 * Destination validation (open-redirect protection). The destination is
 * always the offer's stored product URL, never a client value; it must be
 * https, carry no credentials, and its host must be on the provider's
 * allowlist AND be the source's own domain (or a subdomain of it).
 */
export type DestinationCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function validateDestination(
  raw: string,
  allowedHosts: readonly string[],
  sourceDomain: string,
): DestinationCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not https" };
  if (url.username || url.password) return { ok: false, reason: "credentials in URL" };
  const host = url.hostname.toLowerCase();
  const domain = sourceDomain.toLowerCase().replace(/^www\./, "");
  if (!(host === domain || host.endsWith(`.${domain}`)))
    return { ok: false, reason: `host ${host} is not ${domain}` };
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host))
    return { ok: false, reason: `host ${host} is not on the allowlist` };
  return { ok: true, url };
}

/** Host of a referrer, never the full URL (no paths or query strings kept). */
export function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    const h = new URL(referrer).hostname.toLowerCase();
    return h.slice(0, 253) || null;
  } catch {
    return null;
  }
}

/** Coarse device class from a user agent; the raw string is never stored. */
export function deviceClass(ua: string | undefined): "mobile" | "desktop" | null {
  if (!ua) return null;
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop";
}

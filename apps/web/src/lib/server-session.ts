import type { MeResponse, PublicUser, SuccessBody } from "@dealmind/shared";
import { cookies } from "next/headers";

const API_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

/**
 * Server-side session check: asks the API who the session cookie belongs to.
 * The cookie is validated by the API (never trusted by mere presence).
 */
export async function getServerUser(): Promise<PublicUser | null> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
  if (!cookieHeader.includes("dm_session=")) return null;
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers: { cookie: cookieHeader, accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return ((await res.json()) as SuccessBody<MeResponse>).data.user;
  } catch {
    return null;
  }
}

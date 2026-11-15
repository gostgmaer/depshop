import "server-only";
import type { SuccessBody } from "@dealmind/shared";

const API_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

/** Server-side GET of a PUBLIC API resource (catalog), e.g. for route metadata. Null on any failure. */
export async function publicGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return ((await res.json()) as SuccessBody<T>).data;
  } catch {
    return null;
  }
}

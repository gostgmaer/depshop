/**
 * Browser API client. Sessions live in an HttpOnly cookie the browser sends
 * automatically: no auth token is ever handled or stored by JavaScript
 * (nothing in localStorage). The only cookie read here is the CSRF token,
 * which is designed to be readable and is copied into the x-csrf-token header.
 */
import { CSRF_HEADER, type ErrorResponseBody } from "@dealmind/shared";

const CSRF_COOKIES = ["__Host-dm_csrf", "dm_csrf"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function readCookie(name: string, cookieString: string): string | undefined {
  for (const part of cookieString.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function csrfFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const name of CSRF_COOKIES) {
    const value = readCookie(name, document.cookie);
    if (value) return value;
  }
  return undefined;
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch("/api/v1/auth/csrf", { credentials: "same-origin", cache: "no-store" });
  const data = (await res.json()) as { csrfToken: string };
  return data.csrfToken;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export async function api<T>(
  method: Method,
  path: string,
  body?: unknown,
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers[CSRF_HEADER] = csrfFromCookie() ?? (await fetchCsrfToken());
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as (T & Partial<ErrorResponseBody>) | null;
  if (res.ok) return data as T;

  const error = data?.error;
  // A stale CSRF cookie (e.g. secret rotated): fetch a fresh token and retry once.
  if (error?.code === "CSRF_INVALID" && !retried) {
    await fetchCsrfToken();
    return api<T>(method, path, body, true);
  }
  throw new ApiError(
    res.status,
    error?.code ?? "INTERNAL",
    error?.message ?? "Something went wrong",
    error?.details,
  );
}

/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export function safeNextPath(
  next: string | null | undefined,
  fallback = "/settings/profile",
): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return fallback;
  return next;
}

/**
 * Browser API client. Sessions live in an HttpOnly cookie the browser sends
 * automatically: no auth token is ever handled or stored by JavaScript
 * (nothing in localStorage). The only cookie read here is the CSRF token,
 * which is designed to be readable and is copied into the x-csrf-token header.
 */
import {
  CSRF_HEADER,
  type ErrorResponseBody,
  type PaginationMeta,
  type SuccessBody,
} from "@dealmind/shared";

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
  const body = (await res.json()) as SuccessBody<{ csrfToken: string }>;
  return body.data.csrfToken;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** No API call may hang the UI: after this the request fails with a TIMEOUT error. */
export const REQUEST_TIMEOUT_MS = 20_000;

export interface RequestOptions {
  /** Aborts the request (TanStack Query passes one to cancel superseded fetches). */
  signal?: AbortSignal;
}

function withTimeout(signal?: AbortSignal): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function")
    return signal;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout])
    : (signal ?? timeout);
}

export interface Page<T> {
  items: T[];
  pagination: PaginationMeta;
}

/** Builds "?a=1&b=x&b=y" from defined values (arrays repeat the key). */
export function queryString(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    const scalar = (x: unknown) =>
      typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const s = scalar(x);
        if (s !== null) q.append(k, s);
      }
    } else {
      const s = scalar(v);
      if (s !== null) q.set(k, s);
    }
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function api<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  return (await request<T>(method, path, body, false, opts)).data;
}

/** A paginated GET: items plus the pagination meta of the envelope. */
export async function apiPage<T>(path: string, opts: RequestOptions = {}): Promise<Page<T>> {
  const res = await request<T[]>("GET", path, undefined, false, opts);
  return {
    items: res.data,
    pagination: res.meta?.pagination ?? {
      page: 1,
      pageSize: res.data.length,
      total: res.data.length,
      totalPages: 1,
    },
  };
}

/** Listeners told when an authenticated call finds the session gone (expired/revoked). */
const sessionListeners = new Set<() => void>();
export function onSessionExpired(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  retried = false,
  opts: RequestOptions = {},
): Promise<{ data: T; meta?: SuccessBody<T>["meta"] }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers[CSRF_HEADER] = csrfFromCookie() ?? (await fetchCsrfToken());
    headers["content-type"] = "application/json";
  }

  const signal = withTimeout(opts.signal);
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  } catch (err) {
    // Our own timeout (not a caller's cancellation) becomes a clear, retryable error.
    if (err instanceof DOMException && err.name === "TimeoutError")
      throw new ApiError(504, "TIMEOUT", "The server took too long to respond. Please try again.");
    throw err;
  }

  if (res.status === 204) return { data: undefined as T };
  const payload = (await res.json().catch(() => null)) as
    (Partial<SuccessBody<T>> & Partial<ErrorResponseBody>) | null;
  // Success responses are enveloped: { success: true, data, meta }.
  if (res.ok) return { data: payload?.data as T, ...(payload?.meta ? { meta: payload.meta } : {}) };

  const error = payload?.error;
  // A stale CSRF cookie (e.g. secret rotated): fetch a fresh token and retry once.
  if (error?.code === "CSRF_INVALID" && !retried) {
    await fetchCsrfToken();
    return request<T>(method, path, body, true, opts);
  }
  if (res.status === 401 && !path.startsWith("/auth/")) for (const l of sessionListeners) l();
  throw new ApiError(
    res.status,
    error?.code ?? "INTERNAL",
    error?.message ?? "Something went wrong",
    error?.details,
  );
}

/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return fallback;
  return next;
}

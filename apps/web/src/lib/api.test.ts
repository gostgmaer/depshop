import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, readCookie, safeNextPath } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowser(cookie: string, responses: Response[]) {
  vi.stubGlobal("document", { cookie });
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("safeNextPath", () => {
  it.each([
    ["/settings/security", "/settings/security"],
    [null, "/settings/profile"],
    ["https://evil.example", "/settings/profile"],
    ["//evil.example", "/settings/profile"],
    // Browsers normalise "/\host" to "//host" (protocol-relative): must be rejected.
    ["/\\evil.example", "/settings/profile"],
    // A plain relative path is legitimate.
    ["/evil.example", "/evil.example"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("api client", () => {
  it("reads cookies by exact name", () => {
    expect(readCookie("dm_csrf", "a=1; dm_csrf=tok.sig; x=2")).toBe("tok.sig");
    expect(readCookie("csrf", "dm_csrf=tok")).toBeUndefined();
  });

  it("sends the CSRF cookie value as x-csrf-token on mutations, never on GETs", async () => {
    const fetchMock = stubBrowser("dm_csrf=nonce.sig", [
      json(200, { ok: 1 }),
      json(200, { ok: 2 }),
    ]);
    await api("POST", "/auth/logout");
    await api("GET", "/auth/me");
    const [, postInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, getInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((postInit.headers as Record<string, string>)["x-csrf-token"]).toBe("nonce.sig");
    expect(postInit.credentials).toBe("same-origin");
    expect((getInit.headers as Record<string, string>)["x-csrf-token"]).toBeUndefined();
  });

  it("fetches a CSRF token when the cookie is missing", async () => {
    const fetchMock = stubBrowser("", [json(200, { csrfToken: "fresh.sig" }), json(200, {})]);
    await api("POST", "/auth/login", { email: "a@b.co", password: "x" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/auth/csrf");
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("fresh.sig");
  });

  it("retries once after CSRF_INVALID, then surfaces API errors as ApiError", async () => {
    stubBrowser("dm_csrf=stale.sig", [
      json(403, { error: { code: "CSRF_INVALID", message: "bad" } }),
      json(200, { csrfToken: "new.sig" }),
      json(401, { error: { code: "UNAUTHENTICATED", message: "Invalid email or password" } }),
    ]);
    const err = await api("POST", "/auth/login", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Invalid email or password",
    });
  });

  it("never touches localStorage", async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    stubBrowser("dm_csrf=n.s", [json(200, { user: {} })]);
    await api("POST", "/auth/login", {});
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

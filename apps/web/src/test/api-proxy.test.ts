// @vitest-environment node
/** Phase 7.1: the same-origin API proxy caps request bodies and forwards an allow-list of headers. */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/[...path]/route";

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => vi.unstubAllGlobals());

describe("API proxy", () => {
  it("refuses bodies over 1 MiB without contacting the API", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const big = new NextRequest("http://web.test/api/v1/watchlists", {
      method: "POST",
      body: "x".repeat(1_048_577),
      headers: { "content-type": "application/json" },
    });
    const res = await POST(big, ctx(["v1", "watchlists"]));
    expect(res.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards allowed headers only, keeps the path inside /api, and never forwards client X-Forwarded-For", async () => {
    const upstream = vi.fn(async () => Response.json({ success: true, data: {} }));
    vi.stubGlobal("fetch", upstream);
    const req = new NextRequest("http://web.test/api/v1/x?y=1", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "t",
        "x-forwarded-for": "6.6.6.6",
        "x-user-id": "someone-else",
        location: "https://evil.example",
        authorization: "Bearer stolen",
      },
    });
    const res = await POST(req, ctx(["v1", "x"]));
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname.startsWith("/api/")).toBe(true);
    const sent = new Headers(init.headers);
    expect(sent.get("x-csrf-token")).toBe("t");
    for (const h of ["x-forwarded-for", "x-user-id", "location", "authorization"])
      expect(sent.get(h), h).toBeNull();
  });

  it("refuses dot segments that would escape /api (e.g. to /internal or /webhooks)", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const path of [
      ["v1", "..", "..", "internal", "v1", "categories"],
      ["..", "webhooks", "easydev-payments"],
      [".", "v1"],
      ["v1", "", "x"],
    ]) {
      const res = await POST(
        new NextRequest("http://web.test/api/x", { method: "POST", body: "{}" }),
        ctx(path),
      );
      expect(res.status, path.join("/")).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

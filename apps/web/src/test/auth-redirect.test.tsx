/** 3. Authentication redirects of the protected (dashboard) layout. */
import { describe, expect, it, vi } from "vitest";

const user = { value: null as null | { id: string; email: string; name: string } };
vi.mock("@/lib/server-session", () => ({ getServerUser: vi.fn(async () => user.value) }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-pathname": "/alerts" })),
}));

describe("protected layout", () => {
  it("sends signed-out visitors to /login with a safe next path", async () => {
    const { default: Layout } = await import("@/app/(dashboard)/layout");
    user.value = null;
    await expect(Layout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/login?next=%2Falerts");
  });

  it("renders the app shell for a verified session", async () => {
    const { default: Layout } = await import("@/app/(dashboard)/layout");
    user.value = { id: "u1", email: "a@example.com", name: "Asha" };
    const el = await Layout({ children: null });
    expect(el).toBeTruthy();
  });
});

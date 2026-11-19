/** Prompt 26: sign-out push cleanup, platform detection, tab bar mapping. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TAB_ITEMS } from "@/components/navigation/mobile-tab-bar";
import { isActive } from "@/components/navigation/nav-items";
import type * as ApiModule from "@/lib/api";
import { useLogout } from "@/lib/auth-hooks";
import type * as PushModule from "@/lib/push";
import { isIosSafari } from "@/lib/pwa";
import { navigation } from "./setup";

const calls = vi.hoisted(() => [] as string[]);
const apiMock = vi.hoisted(() => vi.fn());
const disablePushMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof ApiModule>();
  return { ...actual, api: apiMock };
});
vi.mock("@/lib/push", async (orig) => {
  const actual = await orig<typeof PushModule>();
  return { ...actual, disablePush: disablePushMock };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("sign-out", () => {
  it("turns push off on this browser before ending the session", async () => {
    calls.length = 0;
    disablePushMock.mockImplementation(async () => {
      calls.push("disablePush");
      return "off";
    });
    apiMock.mockImplementation(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
    });
    const { result } = renderHook(() => useLogout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"));
    expect(calls).toEqual(["disablePush", "POST /auth/logout"]);
  });

  it("still signs out when turning push off fails", async () => {
    calls.length = 0;
    disablePushMock.mockRejectedValue(new Error("push service unreachable"));
    apiMock.mockImplementation(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
    });
    const { result } = renderHook(() => useLogout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"));
    expect(calls).toEqual(["POST /auth/logout"]);
  });
});

describe("platform detection", () => {
  it("recognises iPhone and iPad Safari, not other iOS browsers or Android", () => {
    const iphoneSafari =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const iphoneChrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";
    const android =
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
    expect(isIosSafari(iphoneSafari)).toBe(true);
    expect(isIosSafari(iphoneChrome)).toBe(false);
    expect(isIosSafari(android)).toBe(false);
  });
});

describe("mobile tab bar", () => {
  const activeTab = (path: string) =>
    TAB_ITEMS.filter((t) => isActive(path, t)).map((t) => t.label);

  it("marks exactly one tab for every main area", () => {
    expect(activeTab("/dashboard")).toEqual(["Home"]);
    // Searching happens on Deals; past searches still belong to it.
    expect(activeTab("/deals")).toEqual(["Deals"]);
    expect(activeTab("/search/123")).toEqual(["Deals"]);
    expect(activeTab("/watchlists/9")).toEqual(["Watchlists"]);
    expect(activeTab("/alerts")).toEqual(["Alerts"]);
    for (const p of ["/settings/notifications", "/billing", "/notifications", "/history"]) {
      expect(activeTab(p), p).toEqual(["Account"]);
    }
  });

  it("has five tabs at most", () => {
    expect(TAB_ITEMS).toHaveLength(5);
  });
});

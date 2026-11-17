import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Next.js navigation hooks, controllable per test through `navigation`.
export const navigation = {
  pathname: "/dashboard",
  search: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  params: {} as Record<string, string>,
};
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.search,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    refresh: navigation.refresh,
  }),
  useParams: () => navigation.params,
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// jsdom lacks these browser APIs used by Radix / Framer Motion.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => undefined;
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => undefined;
(window as unknown as Record<string, unknown>).matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

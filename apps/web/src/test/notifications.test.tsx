/** Phase 5.3 UI: notification center, settings, browser push, unsubscribe, live updates. */
import { notificationPreferences, notificationView } from "@dealmind/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsView } from "@/app/(dashboard)/notifications/notifications-view";
import { NotificationSettings } from "@/app/(dashboard)/settings/notifications/notification-settings";
import { Unsubscribe } from "@/app/(recovery)/unsubscribe/unsubscribe";
import { PriceAlertForm } from "@/components/alerts/price-alert-form";
import { useNotificationStream } from "@/hooks/use-notification-stream";
import { urlBase64ToBytes } from "@/lib/push";
import * as services from "@/services";
import type { Notification, NotificationPreferences } from "@/types/api";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

const P = "0190a000-0000-7000-8000-0000000000b1";
const V = "0190a000-0000-7000-8000-0000000000b2";

const note = (over: Partial<Notification> = {}): Notification => ({
  id: "0190a000-0000-7000-8000-000000000001",
  type: "TARGET_PRICE_REACHED",
  category: "PRICE_ALERTS",
  critical: false,
  title: "Acme Nova 7 is ₹29,500 on Mock Store Alpha",
  body: "Your target of ₹30,000 was reached.",
  link: `/products/${P}?variant=${V}`,
  data: {},
  readAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

const prefs = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  inAppEnabled: true,
  emailEnabled: true,
  pushEnabled: false,
  categories: {
    PRICE_ALERTS: { inApp: true, email: true, push: true },
    SEARCH: { inApp: true, email: false, push: false },
    ACCOUNT: { inApp: true, email: false, push: true },
    BILLING: { inApp: true, email: true, push: false },
  },
  quietHours: null,
  timezone: "Asia/Kolkata",
  language: "en-IN",
  pushSubscriptions: 0,
  ...over,
});

const page = <T,>(items: T[]) => ({
  items,
  pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 },
});

vi.mock("@/services", () => ({
  notifications: {
    list: vi.fn(),
    unreadCount: vi.fn(async () => ({ unread: 1 })),
    markRead: vi.fn(async () => ({})),
    markAllRead: vi.fn(async () => ({ updated: 1 })),
    remove: vi.fn(async () => undefined),
    preferences: vi.fn(),
    updatePreferences: vi.fn(),
    unsubscribe: vi.fn(),
    streamUrl: "/api/v1/notifications/stream",
  },
  push: {
    config: vi.fn(async () => ({ publicKey: "AQIDBA" })),
    subscribe: vi.fn(async () => ({ id: "s", createdAt: "" })),
    unsubscribe: vi.fn(async () => undefined),
  },
  alerts: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
}));
type Mocked = Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const svc = services as unknown as Mocked;

beforeEach(() => {
  svc.notifications!.list!.mockImplementation(async (o: { category?: string }) =>
    page(
      [
        note(),
        note({
          id: "0190a000-0000-7000-8000-000000000002",
          type: "NEW_SIGN_IN",
          category: "ACCOUNT",
          critical: true,
          title: "New sign-in to your account",
          body: "Signed in on Chrome on Android.",
          link: "/settings/security",
          readAt: new Date().toISOString(),
        }),
      ].filter((n) => !o.category || n.category === o.category),
    ),
  );
  svc.notifications!.preferences!.mockResolvedValue(prefs());
  svc.notifications!.updatePreferences!.mockResolvedValue(prefs());
});

describe("fixtures", () => {
  it("match the API contracts", () => {
    expect(notificationView.safeParse(note()).success).toBe(true);
    expect(notificationPreferences.safeParse(prefs()).success).toBe(true);
  });
});

describe("notification center", () => {
  it("shows categories and security notices, filters by category, opens, deletes", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationsView />);
    expect(await screen.findByText("New sign-in to your account")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText(/Account ·/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Account" }));
    await waitFor(() =>
      expect(svc.notifications!.list!).toHaveBeenLastCalledWith({ category: "ACCOUNT", page: 1 }),
    );
    await waitFor(() => expect(screen.queryByText(/Acme Nova 7 is/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Everything" }));

    await user.click(await screen.findByRole("link", { name: /Acme Nova 7 is/ }));
    expect(svc.notifications!.markRead!).toHaveBeenCalledWith(note().id);
    expect(navigation.push).toHaveBeenCalledWith(`/products/${P}?variant=${V}`);

    await user.click(
      screen.getByRole("button", { name: "Delete notification: New sign-in to your account" }),
    );
    await waitFor(() =>
      expect(svc.notifications!.remove!).toHaveBeenCalledWith(
        "0190a000-0000-7000-8000-000000000002",
      ),
    );
  });
});

describe("notification settings", () => {
  it("toggles a category channel, respects global switches, and locks account notices in-app", async () => {
    const user = userEvent.setup();
    svc.notifications!.preferences!.mockResolvedValue(prefs({ pushEnabled: false }));
    renderWithQuery(<NotificationSettings />);
    const searchEmail = await screen.findByRole("checkbox", { name: "Email: Searches" });
    expect(searchEmail).not.toBeChecked();
    await user.click(searchEmail);
    await waitFor(() =>
      expect(svc.notifications!.updatePreferences!).toHaveBeenCalledWith({
        categories: { SEARCH: { email: true } },
      }),
    );
    // Push is off globally: per-category push can't be changed.
    expect(screen.getByRole("checkbox", { name: "Browser: Price alerts" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "In the app: Account & security" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "In the app: Account & security" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Email: Account & security" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Email: all notifications" }));
    await waitFor(() =>
      expect(svc.notifications!.updatePreferences!).toHaveBeenLastCalledWith({
        emailEnabled: false,
      }),
    );
  });

  it("saves quiet hours with a time zone and rejects equal times", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings />);
    await user.click(await screen.findByRole("checkbox", { name: /Use quiet hours/ }));
    const from = screen.getByLabelText("From");
    const until = screen.getByLabelText("Until");
    await user.clear(until);
    await user.type(until, "22:00");
    expect(screen.getByText("Start and end must differ.")).toBeInTheDocument();
    await user.clear(until);
    await user.type(until, "07:30");
    await user.selectOptions(screen.getByLabelText("Time zone"), "Europe/London");
    expect(from).toHaveValue("22:00");
    await user.click(screen.getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() =>
      expect(svc.notifications!.updatePreferences!).toHaveBeenCalledWith({
        quietHours: { start: "22:00", end: "07:30" },
        timezone: "Europe/London",
      }),
    );
  });
});

describe("browser push", () => {
  const original = {
    serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"),
  };
  afterEach(() => {
    if (original.serviceWorker)
      Object.defineProperty(navigator, "serviceWorker", original.serviceWorker);
    else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("says when the browser can't do push", async () => {
    renderWithQuery(<NotificationSettings />);
    expect(
      await screen.findByText("This browser doesn't support push notifications."),
    ).toBeInTheDocument();
  });

  it("asks permission only when the user clicks, then stores the subscription", async () => {
    const requestPermission = vi.fn(async () => "granted");
    (window as unknown as Record<string, unknown>).Notification = Object.assign(function () {}, {
      permission: "default",
      requestPermission,
    });
    (window as unknown as Record<string, unknown>).PushManager = function () {};
    const subscription = {
      endpoint: "https://push.example.com/send/1",
      toJSON: () => ({
        endpoint: "https://push.example.com/send/1",
        expirationTime: null,
        keys: { p256dh: "p256", auth: "auth" },
      }),
    };
    const pushManager = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => subscription),
    };
    const reg = { pushManager };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => undefined),
        register: vi.fn(async () => reg),
        ready: Promise.resolve(reg),
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings />);
    const button = await screen.findByRole("button", { name: "Turn on for this browser" });
    expect(requestPermission).not.toHaveBeenCalled();
    await user.click(button);
    await waitFor(() =>
      expect(svc.push!.subscribe!).toHaveBeenCalledWith({
        endpoint: "https://push.example.com/send/1",
        expirationTime: null,
        keys: { p256dh: "p256", auth: "auth" },
      }),
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    // Push was off globally: turning it on for a browser enables the channel.
    await waitFor(() =>
      expect(svc.notifications!.updatePreferences!).toHaveBeenCalledWith({ pushEnabled: true }),
    );
    expect(
      await screen.findByText("This browser receives DealMind notifications."),
    ).toBeInTheDocument();
  });

  it("decodes the VAPID key", () => {
    expect([...urlBase64ToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});

describe("unsubscribe page", () => {
  it("unsubscribes only after a click", async () => {
    navigation.search = new URLSearchParams("token=abc.def");
    svc.notifications!.unsubscribe!.mockResolvedValue({
      category: "PRICE_ALERTS",
      channel: "email",
    });
    const user = userEvent.setup();
    renderWithQuery(<Unsubscribe />);
    expect(svc.notifications!.unsubscribe!).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Unsubscribe from these emails" }));
    expect(await screen.findByText(/won't get price alert emails/)).toBeInTheDocument();
    expect(svc.notifications!.unsubscribe!).toHaveBeenCalledWith("abc.def");
    navigation.search = new URLSearchParams();
  });
});

describe("live updates", () => {
  it("updates the unread count from the stream and refreshes lists", async () => {
    const listeners = new Map<string, (e: MessageEvent<string>) => void>();
    const close = vi.fn();
    class FakeEventSource {
      constructor(
        readonly url: string,
        readonly init: EventSourceInit,
      ) {
        expect(url).toBe("/api/v1/notifications/stream");
        expect(init.withCredentials).toBe(true);
      }
      addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
        listeners.set(type, fn);
      }
      close = close;
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    function Probe() {
      useNotificationStream();
      return null;
    }
    const { client, unmount } = renderWithQuery(<Probe />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => listeners.get("ready")!({ data: '{"unread":3}' } as MessageEvent<string>));
    expect(client.getQueryData(["notifications", "unread"])).toEqual({ unread: 3 });
    act(() =>
      listeners.get("change")!({
        data: '{"signal":{"type":"created","id":"x"},"unread":4}',
      } as MessageEvent<string>),
    );
    expect(client.getQueryData(["notifications", "unread"])).toEqual({ unread: 4 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notifications", "list"] });
    unmount();
    expect(close).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("alert channels", () => {
  it("can add browser notifications to an alert", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PriceAlertForm variantId={V} sources={[]} />);
    await user.type(screen.getByLabelText("Target price (₹)"), "20000");
    await user.click(screen.getByRole("checkbox", { name: "Browser" }));
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    await waitFor(() =>
      expect(svc.alerts!.create!).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ["IN_APP", "EMAIL", "PUSH"] }),
      ),
    );
  });
});

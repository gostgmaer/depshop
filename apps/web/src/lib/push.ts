/**
 * Browser push (Web Push + service worker). Permission is requested only
 * from an explicit user action (the "Turn on" button), never on page load.
 */
import { push } from "@/services";

export type PushState =
  | "unsupported" // no service worker / Push API / Notification API
  | "unavailable" // the server has no VAPID key configured
  | "denied" // the user blocked notifications for this site
  | "off" // allowed or not asked yet, but this browser isn't subscribed
  | "on"; // this browser is subscribed

export const SERVICE_WORKER_URL = "/sw.js";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** base64url → Uint8Array (applicationServerKey). */
export function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL)) ?? null;
}

export async function pushState(publicKey: string | null): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!publicKey) return "unavailable";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Must be called from a user gesture (click). */
export async function enablePush(publicKey: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error("The browser returned an incomplete push subscription");
  await push.subscribe({
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return "on";
}

/** Stops push on this browser (server first, then the browser subscription). */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await push.unsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
}

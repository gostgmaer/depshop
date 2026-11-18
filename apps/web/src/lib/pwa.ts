/**
 * Service-worker registration and install helpers (docs/pwa-architecture.md).
 * Registration never asks for any permission; push permission stays an explicit
 * user action in Settings → Notifications.
 */
import { SERVICE_WORKER_URL } from "./push";

export function serviceWorkerSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

/** Registers the service worker once the page has loaded (production builds only). */
export function registerServiceWorker(): void {
  if (!serviceWorkerSupported() || process.env.NODE_ENV !== "production") return;
  const register = () => {
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }).catch(() => undefined);
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/** Tells the service worker the user signed out (it drops any non-static cache). */
export function notifySignedOut(): void {
  if (!serviceWorkerSupported()) return;
  navigator.serviceWorker.controller?.postMessage({ type: "SIGNED_OUT" });
}

/** True when running as an installed app (any platform). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

/** iPhone/iPad Safari: no install prompt API; installation is manual (Share → Add to Home Screen). */
export function isIosSafari(userAgent: string = navigator.userAgent): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && typeof document !== "undefined" && "ontouchend" in document);
  return ios && /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
}

/** Chromium's install prompt event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

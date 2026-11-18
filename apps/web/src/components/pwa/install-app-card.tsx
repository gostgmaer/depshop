"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { type BeforeInstallPromptEvent, isIosSafari, isStandalone } from "@/lib/pwa";

type InstallState = "checking" | "installed" | "prompt" | "ios" | "manual";

/**
 * "Install the app" in Settings (docs/pwa-architecture.md). It lives on a settings
 * page, not as a pop-up, so it never interrupts anyone:
 *   - Chromium (Android Chrome, desktop Chrome/Edge): the browser's own install prompt;
 *   - iPhone/iPad Safari: manual steps (Safari has no install prompt API);
 *   - elsewhere: how to install from the browser menu, or that it isn't supported.
 */
export function InstallAppCard() {
  const [state, setState] = useState<InstallState>("checking");
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone()) {
      setState("installed");
      return;
    }
    setState(isIosSafari() ? "ios" : "manual");
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep the browser's mini-infobar from appearing on its own
      setPromptEvent(e as BeforeInstallPromptEvent);
      setState("prompt");
    };
    const onInstalled = () => {
      setPromptEvent(null);
      setState("installed");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    setPromptEvent(null); // the event can be used once
    setState(outcome === "accepted" ? "installed" : "manual");
  };

  return (
    <Card>
      <CardHeader
        title="Install the app"
        description="Open DealMind from your home screen, in its own window. It's the same account and the same data as the website."
      />
      {state === "installed" ? (
        <p className="text-sm" role="status">
          DealMind is installed on this device.
        </p>
      ) : state === "prompt" ? (
        <Button size="sm" onClick={() => void install()}>
          Install DealMind
        </Button>
      ) : state === "ios" ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Tap the <span className="font-medium text-foreground">Share</span> button in Safari.
          </li>
          <li>
            Choose <span className="font-medium text-foreground">Add to Home Screen</span>.
          </li>
          <li>
            Tap <span className="font-medium text-foreground">Add</span>.
          </li>
        </ol>
      ) : state === "manual" ? (
        <p className="text-sm text-muted-foreground">
          If your browser supports installing websites, use its menu (for example{" "}
          <span className="font-medium text-foreground">Install app</span> or{" "}
          <span className="font-medium text-foreground">Add to Home screen</span>). Some browsers
          don't install websites; DealMind works the same in a browser tab.
        </p>
      ) : null}
    </Card>
  );
}

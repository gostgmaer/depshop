"use client";

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategoryValue,
  type NotificationChannelKey,
} from "@dealmind/shared";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Moon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/misc";
import { Checkbox, Label } from "@/components/ui/primitives";
import { useNotificationPreferences, useUpdateNotificationPreferences } from "@/hooks/queries";
import { errorMessage } from "@/lib/auth-hooks";
import { type PushState, disablePush, enablePush, pushState } from "@/lib/push";
import { push } from "@/services";
import type { NotificationPreferences, UpdateNotificationPreferences } from "@/types/api";

const CATEGORY: Record<NotificationCategoryValue, { label: string; hint: string }> = {
  PRICE_ALERTS: {
    label: "Price alerts",
    hint: "Targets reached, price drops, back in stock, alerts ending",
  },
  SEARCH: { label: "Searches", hint: "When a long search finishes or fails" },
  ACCOUNT: {
    label: "Account & security",
    hint: "Password changes and sign-ins from new devices. Always shown in the app; security emails come from your EasyDev account service.",
  },
  BILLING: {
    label: "Billing",
    hint: "Payments, renewals, failed payments and plan changes. Always shown in the app.",
  },
};
const CHANNEL: Record<NotificationChannelKey, string> = {
  inApp: "In the app",
  email: "Email",
  push: "Browser",
};
const GLOBAL: Record<NotificationChannelKey, "inAppEnabled" | "emailEnabled" | "pushEnabled"> = {
  inApp: "inAppEnabled",
  email: "emailEnabled",
  push: "pushEnabled",
};

const TIME_ZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
];

/** A channel can't be changed for this category (fixed by policy). */
const locked = (c: NotificationCategoryValue, ch: NotificationChannelKey) =>
  (c === "ACCOUNT" && (ch === "inApp" || ch === "email")) || (c === "BILLING" && ch === "inApp");

export function NotificationSettings() {
  const prefs = useNotificationPreferences();
  const save = useUpdateNotificationPreferences();
  const update = (body: UpdateNotificationPreferences) => save.mutate(body);

  if (prefs.isPending)
    return <p className="text-sm text-muted-foreground">Loading notification settings…</p>;
  if (prefs.isError) return <Alert tone="error">{errorMessage(prefs.error)}</Alert>;
  const p = prefs.data;

  return (
    <>
      {save.isError ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      <Card>
        <CardHeader
          title="Notification channels"
          description="Choose how DealMind tells you about each kind of update. A channel turned off at the top is off for everything."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">Notification channels by category</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Category
                </th>
                {(Object.keys(CHANNEL) as NotificationChannelKey[]).map((ch) => (
                  <th key={ch} scope="col" className="px-2 py-2 text-center font-medium">
                    {CHANNEL[ch]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <th scope="row" className="py-3 pr-4 text-left font-medium">
                  All notifications
                </th>
                {(Object.keys(CHANNEL) as NotificationChannelKey[]).map((ch) => (
                  <td key={ch} className="px-2 py-3 text-center">
                    <Checkbox
                      aria-label={`${CHANNEL[ch]}: all notifications`}
                      checked={p[GLOBAL[ch]]}
                      disabled={save.isPending}
                      onCheckedChange={(v) => update({ [GLOBAL[ch]]: v === true })}
                    />
                  </td>
                ))}
              </tr>
              {NOTIFICATION_CATEGORIES.map((c) => (
                <tr key={c}>
                  <th scope="row" className="py-3 pr-4 text-left align-top font-normal">
                    <span className="font-medium">{CATEGORY[c].label}</span>
                    <span className="block text-xs text-muted-foreground">{CATEGORY[c].hint}</span>
                  </th>
                  {(Object.keys(CHANNEL) as NotificationChannelKey[]).map((ch) => (
                    <td key={ch} className="px-2 py-3 text-center align-top">
                      <Checkbox
                        aria-label={`${CHANNEL[ch]}: ${CATEGORY[c].label}`}
                        checked={p.categories[c][ch] && (locked(c, ch) || p[GLOBAL[ch]])}
                        disabled={save.isPending || locked(c, ch) || !p[GLOBAL[ch]]}
                        onCheckedChange={(v) =>
                          update({ categories: { [c]: { [ch]: v === true } } })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <PushCard prefs={p} />
      <QuietHoursCard prefs={p} onSave={update} pending={save.isPending} />
    </>
  );
}

function PushCard({ prefs }: { prefs: NotificationPreferences }) {
  const config = useQuery({
    queryKey: ["push", "config"],
    queryFn: push.config,
    staleTime: Infinity,
  });
  const save = useUpdateNotificationPreferences();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicKey = config.data?.publicKey ?? null;

  useEffect(() => {
    if (!config.isSuccess) return;
    let live = true;
    void pushState(publicKey).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [config.isSuccess, publicKey]);

  const run = async (fn: () => Promise<PushState>, after?: (s: PushState) => void) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      setState(s);
      after?.(s);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const message: Record<PushState, string> = {
    unsupported: "This browser doesn't support push notifications.",
    unavailable: "Browser notifications aren't available on this DealMind server yet.",
    denied:
      "Notifications are blocked for this site. Allow them in your browser's site settings, then come back.",
    off: "Get price alerts on this device even when DealMind isn't open.",
    on: "This browser receives DealMind notifications.",
  };

  return (
    <Card>
      <CardHeader
        title="Browser notifications"
        description={
          prefs.pushSubscriptions
            ? `${prefs.pushSubscriptions} browser${prefs.pushSubscriptions === 1 ? "" : "s"} subscribed on your account.`
            : "No browser is subscribed yet."
        }
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {state === null ? (
        <p className="text-sm text-muted-foreground">Checking this browser…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm" role="status">
            {message[state]}
          </p>
          {state === "off" && publicKey ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () => enablePush(publicKey),
                  (s) => {
                    if (s === "on" && !prefs.pushEnabled) save.mutate({ pushEnabled: true });
                  },
                )
              }
            >
              <BellRing aria-hidden className="size-4" />
              {busy ? "Turning on…" : "Turn on for this browser"}
            </Button>
          ) : null}
          {state === "on" ? (
            <Button variant="outline" disabled={busy} onClick={() => void run(disablePush)}>
              {busy ? "Turning off…" : "Turn off for this browser"}
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function QuietHoursCard({
  prefs,
  onSave,
  pending,
}: {
  prefs: NotificationPreferences;
  onSave: (b: UpdateNotificationPreferences) => void;
  pending: boolean;
}) {
  const [on, setOn] = useState(prefs.quietHours !== null);
  const [start, setStart] = useState(prefs.quietHours?.start ?? "22:00");
  const [end, setEnd] = useState(prefs.quietHours?.end ?? "07:00");
  const [tz, setTz] = useState(prefs.timezone);
  const zones = TIME_ZONES.includes(prefs.timezone) ? TIME_ZONES : [prefs.timezone, ...TIME_ZONES];
  const invalid = on && start === end;
  const dirty =
    on !== (prefs.quietHours !== null) ||
    (on && (start !== prefs.quietHours?.start || end !== prefs.quietHours?.end)) ||
    tz !== prefs.timezone;
  return (
    <Card>
      <CardHeader
        title="Quiet hours"
        description="Emails and browser notifications wait until quiet hours end (in-app notices still appear). Security notices are never delayed."
      />
      <form
        className="flex max-w-md flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid) return;
          onSave({ quietHours: on ? { start, end } : null, timezone: tz });
        }}
      >
        <div className="flex items-center gap-2">
          <Checkbox id="quiet-on" checked={on} onCheckedChange={(v) => setOn(v === true)} />
          <Label htmlFor="quiet-on" className="font-normal">
            <Moon aria-hidden className="mr-1 inline size-4" />
            Use quiet hours
          </Label>
        </div>
        {on ? (
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="quiet-start">From</Label>
              <Input
                id="quiet-start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="quiet-end">Until</Label>
              <Input
                id="quiet-end"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                required
              />
            </div>
          </div>
        ) : null}
        {invalid ? <p className="text-sm text-danger">Start and end must differ.</p> : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor="quiet-tz">Time zone</Label>
          <NativeSelect id="quiet-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </NativeSelect>
        </div>
        <p className="text-xs text-muted-foreground">
          Notification language: English (India). Prices are shown in rupees.
        </p>
        <div>
          <Button type="submit" disabled={!dirty || invalid || pending}>
            {pending ? "Saving…" : "Save quiet hours"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

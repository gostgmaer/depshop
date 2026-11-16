"use client";

/**
 * Create or edit a price alert. Only the fields of the chosen condition are
 * shown and sent; money is parsed from rupee text into integer paise. The
 * same component edits an existing alert (its condition type is fixed).
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { ALERT_TYPES, ALERT_TYPE_PARAM, MoneyError, parseRupeesToPaise } from "@dealmind/shared";
import { BellPlus, Pencil } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/misc";
import { Checkbox, Dialog, DialogContent, DialogTrigger, Label } from "@/components/ui/primitives";
import { useAlertMutations } from "@/hooks/queries";
import { ALERT_TYPE_LABEL, TRACKING_EXPLAINER } from "@/lib/alerts";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDate, rupees } from "@/lib/format";
import type { CreateAlertRequest, PriceAlert, UpdateAlertRequest } from "@/types/api";

const DAY = 86_400_000;
const money = (v: string) => {
  try {
    return parseRupeesToPaise(v) > 0;
  } catch {
    return false;
  }
};

const schema = z
  .object({
    type: z.enum(ALERT_TYPES),
    target: z.string().trim(),
    dropPercent: z.string().trim(),
    windowDays: z.enum(["30", "90", "180", "365"]),
    minChange: z.string().trim(),
    cooldownMinutes: z.enum(["0", "60", "360", "1440", "4320"]),
    sourceId: z.string(),
    inApp: z.boolean(),
    email: z.boolean(),
    push: z.boolean(),
    repeat: z.boolean(),
    /** "" = no end, "keep" = keep the current end date, otherwise days from now. */
    ends: z.enum(["", "keep", "7", "30", "90"]),
  })
  .superRefine((v, ctx) => {
    const param = ALERT_TYPE_PARAM[v.type];
    if (param === "target" && !money(v.target))
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: v.target ? "Enter an amount like 24,999 or 24999.50" : "Enter a target price",
      });
    if (param === "drop") {
      const n = Number(v.dropPercent);
      if (!/^\d+$/.test(v.dropPercent) || n < 1 || n > 90)
        ctx.addIssue({
          code: "custom",
          path: ["dropPercent"],
          message: "Enter a whole percent from 1 to 90",
        });
    }
    if (param === "minChange" && v.minChange && !money(v.minChange))
      ctx.addIssue({
        code: "custom",
        path: ["minChange"],
        message: "Enter an amount like 500, or leave it empty",
      });
    if (!v.inApp && !v.email && !v.push)
      ctx.addIssue({
        code: "custom",
        path: ["email"],
        message: "Choose at least one way to be notified",
      });
  });
type Values = z.infer<typeof schema>;

/** Rupee text → integer paise (string-based; no floating point). */
export function targetPaise(text: string): number {
  try {
    return parseRupeesToPaise(text);
  } catch (err) {
    if (err instanceof MoneyError) return 0;
    throw err;
  }
}

/** Integer paise → editable rupee text ("24999", "24999.50"), without floating point. */
function paiseText(paise: number | null): string {
  if (!paise) return "";
  const fraction = paise % 100;
  return `${Math.trunc(paise / 100)}${fraction ? `.${String(fraction).padStart(2, "0")}` : ""}`;
}

const COOLDOWNS = ["0", "60", "360", "1440", "4320"] as const;

function defaults(alert?: PriceAlert): Values {
  if (!alert)
    return {
      type: "TARGET_PRICE",
      target: "",
      dropPercent: "10",
      windowDays: "90",
      minChange: "",
      cooldownMinutes: "1440",
      sourceId: "",
      inApp: true,
      email: true,
      push: false,
      repeat: false,
      ends: "",
    };
  const cooldown = String(alert.cooldownMinutes);
  return {
    type: alert.type,
    target: paiseText(alert.targetPricePaise),
    dropPercent: alert.dropPercentBp ? String(Math.floor(alert.dropPercentBp / 100)) : "10",
    windowDays: String(alert.historicalWindowDays ?? 90) as Values["windowDays"],
    minChange: paiseText(alert.minChangePaise),
    cooldownMinutes: (COOLDOWNS as readonly string[]).includes(cooldown)
      ? (cooldown as Values["cooldownMinutes"])
      : "1440",
    sourceId: alert.source?.id ?? "",
    inApp: alert.channels.includes("IN_APP"),
    email: alert.channels.includes("EMAIL"),
    push: alert.channels.includes("PUSH"),
    repeat: alert.repeat,
    ends: alert.expiresAt ? "keep" : "",
  };
}

function conditionParams(v: Values) {
  const param = ALERT_TYPE_PARAM[v.type];
  return {
    ...(param === "target" ? { targetPricePaise: parseRupeesToPaise(v.target) } : {}),
    ...(param === "drop" ? { dropPercent: Number(v.dropPercent) } : {}),
    ...(param === "window"
      ? { historicalWindowDays: Number(v.windowDays) as 30 | 90 | 180 | 365 }
      : {}),
  };
}

const channelsOf = (v: Values): ("IN_APP" | "EMAIL" | "PUSH")[] => [
  ...(v.inApp ? (["IN_APP"] as const) : []),
  ...(v.email ? (["EMAIL"] as const) : []),
  ...(v.push ? (["PUSH"] as const) : []),
];
/** The server's default channels; sent only when they differ. */
const DEFAULT_CHANNELS = "IN_APP,EMAIL";

const endOf = (v: Values): string | null | undefined =>
  v.ends === ""
    ? null
    : v.ends === "keep"
      ? undefined
      : new Date(Date.now() + Number(v.ends) * DAY).toISOString();

/** POST /alerts body: only options that differ from the defaults are sent. */
export function createPayload(variantId: string, v: Values): CreateAlertRequest {
  const channels = channelsOf(v);
  const expiresAt = endOf(v);
  return {
    variantId,
    type: v.type,
    ...conditionParams(v),
    ...(ALERT_TYPE_PARAM[v.type] === "minChange" && v.minChange
      ? { minChangePaise: parseRupeesToPaise(v.minChange) }
      : {}),
    cooldownMinutes: Number(v.cooldownMinutes),
    ...(channels.join() !== DEFAULT_CHANNELS ? { channels } : {}),
    ...(v.repeat ? { repeat: true } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(v.sourceId ? { sourceId: v.sourceId } : {}),
  };
}

/** PATCH /alerts/:id body. */
export function updatePayload(v: Values, withSource: boolean): UpdateAlertRequest {
  const expiresAt = endOf(v);
  return {
    ...conditionParams(v),
    ...(ALERT_TYPE_PARAM[v.type] === "minChange"
      ? { minChangePaise: v.minChange ? parseRupeesToPaise(v.minChange) : null }
      : {}),
    cooldownMinutes: Number(v.cooldownMinutes),
    channels: channelsOf(v),
    repeat: v.repeat,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(withSource ? { sourceId: v.sourceId || null } : {}),
  };
}

export function PriceAlertForm({
  variantId,
  currentPricePaise,
  sources,
  alert,
  onCreated,
  onDone,
}: {
  variantId: string;
  currentPricePaise?: number | null;
  /** Marketplaces to choose from (current offers of this variant). */
  sources: { id: string; name: string }[];
  /** Edit this alert instead of creating one. */
  alert?: PriceAlert;
  onCreated?: () => void;
  onDone?: () => void;
}) {
  const { create, update } = useAlertMutations();
  const [done, setDone] = useState(false);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(alert) });
  const type = form.watch("type");
  const param = ALERT_TYPE_PARAM[type];
  const e = form.formState.errors;

  const submit = form.handleSubmit(async (v) => {
    try {
      if (alert) {
        await update.mutateAsync({ id: alert.id, body: updatePayload(v, sources.length > 0) });
        onDone?.();
      } else {
        await create.mutateAsync(createPayload(variantId, v));
        setDone(true);
        onCreated?.();
      }
    } catch (err) {
      form.setError("root", { message: errorMessage(err) });
    }
  });

  if (done) return <Alert tone="success">Alert saved. {TRACKING_EXPLAINER}</Alert>;

  return (
    <form onSubmit={(ev) => void submit(ev)} className="flex flex-col gap-4" noValidate>
      {e.root ? <Alert tone="error">{e.root.message}</Alert> : null}
      {alert ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Condition: </span>
          {ALERT_TYPE_LABEL[alert.type]}
        </p>
      ) : (
        <Field label="Notify me when">
          {(p) => (
            <NativeSelect {...p} {...form.register("type")}>
              {ALERT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ALERT_TYPE_LABEL[t]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      )}
      {param === "target" ? (
        <Field
          label="Target price (₹)"
          error={e.target?.message}
          hint={
            currentPricePaise
              ? `Delivered price (incl. shipping). Current lowest: ${rupees(currentPricePaise)}`
              : "Delivered price, including shipping"
          }
        >
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              placeholder="e.g. 22,999"
              {...form.register("target")}
            />
          )}
        </Field>
      ) : null}
      {param === "drop" ? (
        <Field
          label="Drop by (%)"
          error={e.dropPercent?.message}
          hint={
            alert?.baselinePricePaise
              ? `Measured from ${rupees(alert.baselinePricePaise)}, the price when the alert started`
              : currentPricePaise
                ? `Measured from today's lowest delivered price, ${rupees(currentPricePaise)}`
                : "Measured from the price at the next check"
          }
        >
          {(p) => <Input {...p} inputMode="numeric" {...form.register("dropPercent")} />}
        </Field>
      ) : null}
      {param === "window" ? (
        <Field
          label="Lower than every price in the last"
          hint="Needs at least 3 earlier observations over 7+ days; never an all-time claim."
        >
          {(p) => (
            <NativeSelect {...p} {...form.register("windowDays")}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
              <option value="365">12 months</option>
            </NativeSelect>
          )}
        </Field>
      ) : null}
      {param === "minChange" ? (
        <Field
          label="Only if it changes by at least (₹)"
          error={e.minChange?.message}
          hint="Optional. Leave empty to be told about any change."
        >
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              placeholder="e.g. 500"
              {...form.register("minChange")}
            />
          )}
        </Field>
      ) : null}
      {sources.length || !alert ? (
        <Field
          label={type === "PRICE_DROP" ? "Marketplace to watch" : "Marketplace"}
          hint="Only this marketplace's price, or any connected one"
        >
          {(p) => (
            <NativeSelect {...p} {...form.register("sourceId")}>
              <option value="">Any marketplace</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Notify me by</legend>
        <div className="flex flex-wrap gap-4">
          {(["inApp", "email", "push"] as const).map((k) => (
            <div key={k} className="flex items-center gap-2">
              <Checkbox
                id={`alert-${k}`}
                checked={form.watch(k)}
                onCheckedChange={(c) => form.setValue(k, c === true, { shouldValidate: true })}
              />
              <Label htmlFor={`alert-${k}`} className="font-normal">
                {k === "inApp" ? "In the app" : k === "email" ? "Email" : "Browser"}
              </Label>
            </div>
          ))}
        </div>
        {e.email?.message ? <p className="text-sm text-danger">{e.email.message}</p> : null}
        <p className="text-xs text-muted-foreground">
          Your notification settings still apply. Browser notifications need to be turned on in{" "}
          <Link href="/settings/notifications" className="underline">
            notification settings
          </Link>
          .
        </p>
      </fieldset>
      <Field label="Notify at most once every">
        {(p) => (
          <NativeSelect {...p} {...form.register("cooldownMinutes")}>
            <option value="0">No limit</option>
            <option value="60">1 hour</option>
            <option value="360">6 hours</option>
            <option value="1440">24 hours</option>
            <option value="4320">3 days</option>
          </NativeSelect>
        )}
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id="alert-repeat"
          checked={form.watch("repeat")}
          onCheckedChange={(c) => form.setValue("repeat", c === true)}
        />
        <Label htmlFor="alert-repeat" className="font-normal">
          Keep watching after notifying me
          <span className="block text-xs text-muted-foreground">
            Otherwise the alert stops once met; you can turn it back on.
          </span>
        </Label>
      </div>
      <Field label="End">
        {(p) => (
          <NativeSelect {...p} {...form.register("ends")}>
            {alert?.expiresAt ? (
              <option value="keep">Keep: ends {formatDate(alert.expiresAt)}</option>
            ) : null}
            <option value="">No end date</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
          </NativeSelect>
        )}
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {alert ? (
          <Pencil aria-hidden className="size-4" />
        ) : (
          <BellPlus aria-hidden className="size-4" />
        )}
        {form.formState.isSubmitting ? "Saving…" : alert ? "Save changes" : "Create alert"}
      </Button>
    </form>
  );
}

export function PriceAlertDialog(
  props: Parameters<typeof PriceAlertForm>[0] & { size?: "sm" | "default" },
) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size={props.size ?? "sm"}>
          <BellPlus aria-hidden className="size-4" /> Price alert
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Create a price alert"
        description="Get notified when this variant meets your condition on a connected marketplace."
      >
        <PriceAlertForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** Edit an existing alert (condition values, channels, cooldown, repeat, end, marketplace). */
export function AlertEditDialog({
  alert,
  sources = [],
}: {
  alert: PriceAlert;
  sources?: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Edit alert for ${alert.product.name}`}>
          <Pencil aria-hidden className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent title="Edit price alert" description={alert.product.name}>
        <PriceAlertForm
          variantId={alert.variant.id}
          currentPricePaise={alert.current?.deliveredPaise ?? null}
          sources={sources}
          alert={alert}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

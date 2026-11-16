"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ALERT_TYPES, MoneyError, parseRupeesToPaise } from "@dealmind/shared";
import { BellPlus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/primitives";
import { useAlertMutations } from "@/hooks/queries";
import { errorMessage } from "@/lib/auth-hooks";
import { ALERT_TYPE_LABEL, TRACKING_EXPLAINER } from "@/lib/alerts";
import { rupees } from "@/lib/format";

const TARGET_TYPES = new Set(["TARGET_PRICE", "PRICE_BELOW"]);

const schema = z
  .object({
    type: z.enum(ALERT_TYPES),
    target: z.string().trim(),
    dropPercent: z.string().trim(),
    windowDays: z.enum(["30", "90", "180", "365"]),
    cooldownMinutes: z.enum(["60", "360", "1440", "4320"]),
    sourceId: z.string(),
  })
  .superRefine((v, ctx) => {
    if (TARGET_TYPES.has(v.type)) {
      let ok = false;
      try {
        ok = parseRupeesToPaise(v.target) > 0;
      } catch {
        ok = false;
      }
      if (!ok)
        ctx.addIssue({
          code: "custom",
          path: ["target"],
          message: v.target ? "Enter an amount like 24,999 or 24999.50" : "Enter a target price",
        });
    }
    if (v.type === "PERCENT_DROP") {
      const n = Number(v.dropPercent);
      if (!/^\d+$/.test(v.dropPercent) || n < 1 || n > 90)
        ctx.addIssue({
          code: "custom",
          path: ["dropPercent"],
          message: "Enter a whole percent from 1 to 90",
        });
    }
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

export function PriceAlertForm({
  variantId,
  currentPricePaise,
  sources,
  onCreated,
}: {
  variantId: string;
  currentPricePaise?: number | null;
  sources: { id: string; name: string }[];
  onCreated?: () => void;
}) {
  const { create } = useAlertMutations();
  const [done, setDone] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: "TARGET_PRICE",
      target: "",
      dropPercent: "10",
      windowDays: "90",
      cooldownMinutes: "1440",
      sourceId: "",
    },
  });
  const type = form.watch("type");

  const submit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync({
        variantId,
        type: v.type,
        ...(TARGET_TYPES.has(v.type) ? { targetPricePaise: parseRupeesToPaise(v.target) } : {}),
        ...(v.type === "PERCENT_DROP" ? { dropPercent: Number(v.dropPercent) } : {}),
        ...(v.type === "HISTORICAL_LOW"
          ? { historicalWindowDays: Number(v.windowDays) as 30 | 90 | 180 | 365 }
          : {}),
        cooldownMinutes: Number(v.cooldownMinutes),
        ...(v.sourceId ? { sourceId: v.sourceId } : {}),
      });
      setDone(true);
      onCreated?.();
    } catch (err) {
      form.setError("root", { message: errorMessage(err) });
    }
  });

  if (done) return <Alert tone="success">Alert saved. {TRACKING_EXPLAINER}</Alert>;

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      {form.formState.errors.root ? (
        <Alert tone="error">{form.formState.errors.root.message}</Alert>
      ) : null}
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
      {TARGET_TYPES.has(type) ? (
        <Field
          label="Target price (₹)"
          error={form.formState.errors.target?.message}
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
      {type === "PERCENT_DROP" ? (
        <Field
          label="Drop by (%)"
          error={form.formState.errors.dropPercent?.message}
          hint={
            currentPricePaise
              ? `Measured from today's lowest delivered price, ${rupees(currentPricePaise)}`
              : "Measured from the price at the next check"
          }
        >
          {(p) => <Input {...p} inputMode="numeric" {...form.register("dropPercent")} />}
        </Field>
      ) : null}
      {type === "HISTORICAL_LOW" ? (
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
      <Field label="Notify at most once every">
        {(p) => (
          <NativeSelect {...p} {...form.register("cooldownMinutes")}>
            <option value="60">1 hour</option>
            <option value="360">6 hours</option>
            <option value="1440">24 hours</option>
            <option value="4320">3 days</option>
          </NativeSelect>
        )}
      </Field>
      <Field label="Marketplace" hint="Only this marketplace's price, or any connected one">
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
      <Button type="submit" disabled={form.formState.isSubmitting}>
        <BellPlus aria-hidden className="size-4" />
        {form.formState.isSubmitting ? "Creating…" : "Create alert"}
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
        description="Get notified when this variant reaches your target price on an active marketplace."
      >
        <PriceAlertForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

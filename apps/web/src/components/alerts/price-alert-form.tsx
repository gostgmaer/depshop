"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MoneyError, parseRupeesToPaise } from "@dealmind/shared";
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
import { rupees } from "@/lib/format";

const schema = z.object({
  target: z
    .string()
    .trim()
    .min(1, "Enter a target price")
    .refine((v) => {
      try {
        return parseRupeesToPaise(v) > 0;
      } catch {
        return false;
      }
    }, "Enter an amount like 24,999 or 24999.50"),
  sourceId: z.string(),
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
    defaultValues: { target: "", sourceId: "" },
  });

  const submit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync({
        variantId,
        targetPricePaise: parseRupeesToPaise(v.target),
        ...(v.sourceId ? { sourceId: v.sourceId } : {}),
      });
      setDone(true);
      onCreated?.();
    } catch (err) {
      form.setError("root", { message: errorMessage(err) });
    }
  });

  if (done)
    return (
      <Alert tone="success">
        Alert saved. Automatic price checks for alerts are not running yet — they start with
        background price tracking, and you'll be notified from then on.
      </Alert>
    );

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      {form.formState.errors.root ? (
        <Alert tone="error">{form.formState.errors.root.message}</Alert>
      ) : null}
      <Field
        label="Target price (₹)"
        error={form.formState.errors.target?.message}
        hint={
          currentPricePaise
            ? `Current lowest delivered price: ${rupees(currentPricePaise)}`
            : "Notify me at or below this price"
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
      <Field label="Marketplace">
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

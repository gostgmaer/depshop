"use client";

/**
 * Buy a paid plan. The server creates the checkout (and computes the amount);
 * Razorpay Checkout collects the payment; its success handler only forwards
 * the payment id and signature to the server, which verifies them through the
 * payment service and grants the plan from the provider's state. The page
 * never decides that a payment succeeded.
 *
 * SANDBOX checkouts (test mode, no money moves) show clearly labelled
 * "simulate" buttons instead of Razorpay.
 */
import type { BillingIntervalValue } from "@dealmind/shared";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CreditCard, FlaskConical, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/auth-hooks";
import { INTERVAL_LABEL } from "@/lib/billing";
import { rupees } from "@/lib/format";
import { billing } from "@/services";
import type { Checkout } from "@/types/api";

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}
interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", fn: (r: { error?: { description?: string } }) => void): void;
}
type RazorpayCtor = new (opts: Record<string, unknown>) => RazorpayInstance;

let scriptPromise: Promise<RazorpayCtor> | null = null;
export function loadRazorpay(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  scriptPromise ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = RAZORPAY_SCRIPT;
    s.async = true;
    s.onload = () => {
      const ctor = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (ctor) resolve(ctor);
      else reject(new Error("Razorpay Checkout didn't load"));
    };
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't load Razorpay Checkout. Check your connection and retry."));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

type Phase =
  | { kind: "starting" }
  | { kind: "ready"; checkout: Checkout }
  | { kind: "verifying"; checkout: Checkout }
  | { kind: "done"; checkout: Checkout }
  | { kind: "error"; message: string; checkout?: Checkout };

export function CheckoutDialog({
  plan,
  interval,
  planName,
  open,
  onOpenChange,
}: {
  plan: "PRO" | "BUSINESS";
  interval: BillingIntervalValue;
  planName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const started = useRef(false);

  const refreshBilling = () => {
    void qc.invalidateQueries({ queryKey: ["billing"] });
    void qc.invalidateQueries({ queryKey: ["usage"] });
  };

  const start = async () => {
    setPhase({ kind: "starting" });
    try {
      setPhase({ kind: "ready", checkout: await billing.startCheckout({ plan, interval }) });
    } catch (err) {
      setPhase({ kind: "error", message: errorMessage(err) });
    }
  };

  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      void start();
    }
    if (!open) started.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const settle = async (c: Checkout) => {
    if (c.status === "SUCCEEDED") {
      setPhase({ kind: "done", checkout: c });
      refreshBilling();
    } else if (c.status === "VERIFYING") {
      setPhase({ kind: "verifying", checkout: c });
      // The provider confirmed the payment; wait for its subscription record.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        const next = await billing.checkout(c.id).catch(() => null);
        if (next && next.status !== "VERIFYING") return settle(next);
      }
      setPhase({
        kind: "error",
        checkout: c,
        message:
          "Your payment is still being confirmed. You'll get a notification when your plan is active; you don't need to pay again.",
      });
    } else {
      setPhase({
        kind: "error",
        checkout: c,
        message: c.failureReason ?? "The payment didn't go through. You can try again.",
      });
    }
  };

  const confirm = async (c: Checkout, body: Parameters<typeof billing.confirmCheckout>[1]) => {
    setPhase({ kind: "verifying", checkout: c });
    try {
      await settle(await billing.confirmCheckout(c.id, body));
    } catch (err) {
      setPhase({ kind: "error", checkout: c, message: errorMessage(err) });
    }
  };

  const payWithRazorpay = async (c: Checkout) => {
    if (!c.razorpay?.keyId) {
      setPhase({
        kind: "error",
        checkout: c,
        message: "Payment details are missing. Please try again.",
      });
      return;
    }
    try {
      const Razorpay = await loadRazorpay();
      const rzp = new Razorpay({
        key: c.razorpay.keyId,
        subscription_id: c.razorpay.subscriptionId,
        name: "DealMind AI",
        description: `${planName} plan (${INTERVAL_LABEL[c.interval]}ly)`,
        // Only forwarded for server-side verification.
        handler: (r: RazorpayResponse) =>
          void confirm(c, {
            razorpayPaymentId: r.razorpay_payment_id,
            razorpaySubscriptionId: r.razorpay_subscription_id,
            razorpaySignature: r.razorpay_signature,
          }),
        modal: {
          ondismiss: () =>
            setPhase((p) =>
              p.kind === "ready"
                ? {
                    kind: "error",
                    checkout: c,
                    message: "Payment window closed. Nothing was charged; you can try again.",
                  }
                : p,
            ),
        },
        theme: { color: "#0f766e" },
      });
      rzp.on("payment.failed", (r) =>
        setPhase({
          kind: "error",
          checkout: c,
          message: r.error?.description ?? "The payment failed. You can try again.",
        }),
      );
      rzp.open();
    } catch (err) {
      setPhase({ kind: "error", checkout: c, message: errorMessage(err) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Upgrade to ${planName}`}
        description={`Billed ${interval === "ANNUAL" ? "yearly" : "monthly"} until you cancel.`}
      >
        <div className="flex flex-col gap-4" aria-live="polite">
          {phase.kind === "starting" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Preparing a secure checkout…
            </p>
          ) : null}

          {phase.kind === "ready" ? (
            <>
              <p className="text-sm">
                <span className="text-2xl font-semibold tabular">
                  {rupees(phase.checkout.amountPaise)}
                </span>{" "}
                / {INTERVAL_LABEL[phase.checkout.interval]}
              </p>
              {phase.checkout.provider === "SANDBOX" ? (
                <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <FlaskConical aria-hidden className="size-4" /> Sandbox checkout: test mode, no
                    real money moves
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => void confirm(phase.checkout, { sandboxOutcome: "success" })}
                    >
                      Simulate a successful payment
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void confirm(phase.checkout, { sandboxOutcome: "failure" })}
                    >
                      Simulate a declined payment
                    </Button>
                  </div>
                </div>
              ) : (
                <Button onClick={() => void payWithRazorpay(phase.checkout)}>
                  <CreditCard aria-hidden className="size-4" /> Pay with Razorpay
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Your plan changes only after the payment is verified by our payment service.
              </p>
            </>
          ) : null}

          {phase.kind === "verifying" ? (
            <p className="flex items-center gap-2 text-sm">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Confirming your payment…
            </p>
          ) : null}

          {phase.kind === "done" ? (
            <Alert tone="success">
              <CheckCircle2 aria-hidden className="mr-1 inline size-4" />
              Payment confirmed. Your {planName} plan is active.
            </Alert>
          ) : null}

          {phase.kind === "error" ? (
            <>
              <Alert tone="error">
                <XCircle aria-hidden className="mr-1 inline size-4" />
                {phase.message}
              </Alert>
              {/* A verified payment still being recorded must never be paid again. */}
              {phase.checkout?.status === "VERIFYING" ? null : (
                <Button variant="outline" onClick={() => void start()}>
                  Try again
                </Button>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

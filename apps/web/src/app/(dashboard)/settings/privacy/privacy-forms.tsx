"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { ME_KEY, broadcastAuthChange, errorMessage } from "@/lib/auth-hooks";

export const DELETE_CONFIRMATION = "DELETE MY ACCOUNT";

export function ExportDataCard() {
  return (
    <Card>
      <CardHeader
        title="Download your data"
        description="A JSON file with your profile, searches, watchlists, alerts, notifications, sessions and subscription record. Limited to 3 downloads an hour."
      />
      <Button variant="outline" asChild>
        {/* Same-origin GET through the API proxy; the session cookie authorizes it. */}
        <a href="/api/v1/users/me/export" download>
          <Download aria-hidden className="size-4" /> Download my data
        </a>
      </Button>
    </Card>
  );
}

export function DeleteAccountCard() {
  const router = useRouter();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const del = useMutation({
    mutationFn: () => api<null>("POST", "/users/me/delete", { password, confirm }),
    onSuccess: () => {
      qc.setQueryData(ME_KEY, null);
      broadcastAuthChange();
      router.replace("/login?deleted=1");
    },
  });
  const ready = password.length > 0 && confirm === DELETE_CONFIRMATION;
  return (
    <Card className="border-danger/30">
      <CardHeader
        title="Delete your account"
        description={
          <>
            Permanently deletes your DealMind account: searches, watchlists, alerts, notifications
            and settings. Cancel any paid subscription first. Payment records stay with the payment
            provider as the law requires. Your shared EasyDev sign-in is not deleted by this; see
            the{" "}
            <Link href="/privacy" className="underline">
              privacy notice
            </Link>
            .
          </>
        }
      />
      <form
        className="flex max-w-md flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) del.mutate();
        }}
      >
        {del.isError ? <Alert tone="error">{errorMessage(del.error)}</Alert> : null}
        <Field label="Password">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label={`Type ${DELETE_CONFIRMATION} to confirm`}>
          {(p) => (
            <Input
              {...p}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              required
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="danger"
          disabled={!ready || del.isPending}
          className="self-start"
        >
          <Trash2 aria-hidden className="size-4" />
          {del.isPending ? "Deleting…" : "Delete my account"}
        </Button>
      </form>
    </Card>
  );
}

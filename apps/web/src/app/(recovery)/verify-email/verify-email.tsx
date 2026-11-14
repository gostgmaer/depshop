"use client";

import type { MessageResponse } from "@dealmind/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ME_KEY, errorMessage, useMe } from "@/lib/auth-hooks";

export function VerifyEmail() {
  const token = useSearchParams().get("token");
  const queryClient = useQueryClient();
  const me = useMe();
  const started = useRef(false);

  const verify = useMutation({
    mutationFn: (t: string) => api<MessageResponse>("POST", "/auth/verify-email", { token: t }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });
  const resend = useMutation({
    mutationFn: () => api<MessageResponse>("POST", "/auth/resend-verification"),
  });

  // Verify exactly once, even under React Strict Mode's double effects.
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      verify.mutate(token);
    }
  }, [token, verify]);

  if (!token) return <Alert tone="error">This verification link is incomplete.</Alert>;
  if (verify.isPending || verify.isIdle)
    return <p className="text-sm text-muted-foreground">Verifying your email…</p>;

  if (verify.isSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">{verify.data.message}</Alert>
        <Button asChild>
          <Link href={me.data ? "/settings/profile" : "/login"}>
            {me.data ? "Go to your settings" : "Sign in"}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="error">{errorMessage(verify.error)}</Alert>
      {me.data ? (
        resend.isSuccess ? (
          <Alert tone="success">{resend.data.message}</Alert>
        ) : (
          <Button onClick={() => resend.mutate()} disabled={resend.isPending}>
            {resend.isPending ? "Sending…" : "Send a new verification link"}
          </Button>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          <Link href="/login" className="underline underline-offset-4">
            Sign in
          </Link>{" "}
          to request a new verification link.
        </p>
      )}
      {resend.isError ? <Alert tone="error">{errorMessage(resend.error)}</Alert> : null}
    </div>
  );
}

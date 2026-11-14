"use client";

import { type LoginInput, type MeResponse, loginInput } from "@dealmind/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, safeNextPath } from "@/lib/api";
import { ME_KEY, broadcastAuthChange, errorMessage } from "@/lib/auth-hooks";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginInput),
    defaultValues: { email: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const { user } = await api<MeResponse>("POST", "/auth/login", values);
      queryClient.setQueryData(ME_KEY, user);
      broadcastAuthChange();
      router.replace(safeNextPath(params.get("next")));
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      form.resetField("password");
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {params.get("reset") === "1" ? (
        <Alert tone="success">Password updated. Sign in with your new password.</Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field label="Email" error={errors.email?.message}>
        {(p) => (
          <Input
            {...p}
            type="email"
            autoComplete="email"
            inputMode="email"
            {...form.register("email")}
          />
        )}
      </Field>
      <Field label="Password" error={errors.password?.message}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="current-password"
            {...form.register("password")}
          />
        )}
      </Field>
      <div className="-mt-1 text-right text-sm">
        <Link
          href="/forgot-password"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Forgot password?
        </Link>
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

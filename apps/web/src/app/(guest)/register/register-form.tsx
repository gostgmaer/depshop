"use client";

import { type MessageResponse, registerInput } from "@dealmind/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/auth-hooks";

const schema = registerInput
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
type Values = z.infer<typeof schema>;

export function RegisterForm() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ confirmPassword: _confirm, ...values }) => {
    setError(null);
    try {
      const res = await api<MessageResponse>("POST", "/auth/register", values);
      setDone(res.message);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">{done}</Alert>
        <p className="text-sm text-muted-foreground">
          Didn&apos;t get it? Check your spam folder. The link expires in 24 hours.
        </p>
        <Button variant="outline" asChild>
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field label="Name" error={errors.name?.message}>
        {(p) => <Input {...p} autoComplete="name" {...form.register("name")} />}
      </Field>
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
      <Field
        label="Password"
        error={errors.password?.message}
        hint="At least 10 characters, with a letter and a number."
      >
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            {...form.register("password")}
          />
        )}
      </Field>
      <Field label="Confirm password" error={errors.confirmPassword?.message}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            {...form.register("confirmPassword")}
          />
        )}
      </Field>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}

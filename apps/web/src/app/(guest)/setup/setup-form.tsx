"use client";

import { setupAdminInput } from "@dealmind/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LoadingRows } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth-hooks";
import { setup } from "@/services";

const schema = setupAdminInput
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
type Values = z.infer<typeof schema>;

/**
 * First-run setup: the one-time setup token (from the API log, or ADMIN_SETUP_TOKEN)
 * plus the administrator's sign-up details. The account is created in the identity
 * service like any sign-up and becomes ADMIN at its first sign-in.
 */
export function SetupForm() {
  const status = useQuery({ queryKey: ["setup"], queryFn: setup.status, retry: false });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; existingAccount: boolean } | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { token: "", name: "", email: "", password: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ confirmPassword: _confirm, ...values }) => {
    setError(null);
    try {
      setDone(await setup.claim(values));
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (status.isPending) return <LoadingRows rows={2} label="Checking setup" />;

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        {done.existingAccount ? (
          <Alert tone="warning">
            <strong>{done.email}</strong> already has an account. It will become the administrator,
            but its <strong>existing password</strong> applies (the one you just entered was not
            used).
          </Alert>
        ) : (
          <Alert tone="success">
            The administrator account <strong>{done.email}</strong> was created.
          </Alert>
        )}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Verify the e-mail address if you receive a verification e-mail.</li>
          <li>
            Sign in with this e-mail and password. That first sign-in makes it the administrator.
          </li>
        </ol>
        <Button asChild>
          <Link href="/login?next=%2Fadmin">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  if (status.data && !status.data.required) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="info">Setup is complete: an administrator already exists.</Alert>
        <Button variant="outline" asChild>
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        label="Setup token"
        error={errors.token?.message}
        hint="Shown once in the API log at start-up (search the log for “First-run setup”), or the ADMIN_SETUP_TOKEN you configured."
      >
        {(p) => (
          <Input
            {...p}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            {...form.register("token")}
          />
        )}
      </Field>
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
        hint="At least 10 characters with upper- and lowercase letters, a number and one of @$!%*?&."
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
        {isSubmitting ? "Creating administrator…" : "Create administrator"}
      </Button>
    </form>
  );
}

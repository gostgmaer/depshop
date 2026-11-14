"use client";

import {
  type MeResponse,
  type MessageResponse,
  type Preferences,
  SUPPORTED_LOCALES,
  type UpdateProfileInput,
  updateProfileInput,
} from "@dealmind/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { ME_KEY, errorMessage, useMe } from "@/lib/auth-hooks";

export function ProfileCard() {
  const me = useMe();
  const queryClient = useQueryClient();
  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileInput),
    defaultValues: { name: "" },
  });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (me.data) form.reset({ name: me.data.name });
  }, [me.data, form]);

  const save = useMutation({
    mutationFn: (values: UpdateProfileInput) => api<MeResponse>("PATCH", "/users/me", values),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(ME_KEY, user);
      form.reset({ name: user.name });
    },
  });

  return (
    <Card>
      <CardHeader title="Profile" description="How you appear in DealMind." />
      <form
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        noValidate
        className="flex max-w-md flex-col gap-4"
      >
        {save.isError ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        {save.isSuccess && !isDirty ? <Alert tone="success">Profile saved.</Alert> : null}
        <Field label="Name" error={errors.name?.message}>
          {(p) => <Input {...p} autoComplete="name" {...form.register("name")} />}
        </Field>
        <div>
          <Button type="submit" disabled={!isDirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function EmailCard() {
  const me = useMe();
  const resend = useMutation({
    mutationFn: () => api<MessageResponse>("POST", "/auth/resend-verification"),
  });
  const user = me.data;
  if (!user) return null;

  return (
    <Card>
      <CardHeader title="Email" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">{user.email}</span>
        <span
          className={
            user.emailVerified
              ? "rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
              : "rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger"
          }
        >
          {user.emailVerified ? "Verified" : "Not verified"}
        </span>
      </div>
      {!user.emailVerified ? (
        <div className="mt-4 flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            Verify your email to receive price alerts.
          </p>
          {resend.isSuccess ? (
            <Alert tone="success">{resend.data.message}</Alert>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
            >
              {resend.isPending ? "Sending…" : "Resend verification email"}
            </Button>
          )}
          {resend.isError ? <Alert tone="error">{errorMessage(resend.error)}</Alert> : null}
        </div>
      ) : null}
    </Card>
  );
}

const PREFS_KEY = ["preferences"] as const;

const prefsForm = z.object({
  notifyEmail: z.boolean(),
  notifyInApp: z.boolean(),
  locale: z.enum(SUPPORTED_LOCALES),
  brands: z
    .string()
    .max(1_000)
    .refine((v) => v.split(",").filter((b) => b.trim()).length <= 50, "At most 50 brands"),
});
type PrefsForm = z.infer<typeof prefsForm>;

export function PreferencesCard() {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => api<Preferences>("GET", "/users/me/preferences"),
  });
  const form = useForm<PrefsForm>({
    resolver: zodResolver(prefsForm),
    defaultValues: { notifyEmail: true, notifyInApp: true, locale: "en-IN", brands: "" },
  });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (prefs.data) {
      const { notifyEmail, notifyInApp, locale, preferredBrands } = prefs.data;
      form.reset({ notifyEmail, notifyInApp, locale, brands: preferredBrands.join(", ") });
    }
  }, [prefs.data, form]);

  const save = useMutation({
    mutationFn: ({ brands, ...rest }: PrefsForm) =>
      api<Preferences>("PATCH", "/users/me/preferences", {
        ...rest,
        preferredBrands: brands
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean),
      }),
    onSuccess: (data) => queryClient.setQueryData(PREFS_KEY, data),
  });

  return (
    <Card>
      <CardHeader title="Preferences" description="Notifications and shopping defaults." />
      {prefs.isPending ? (
        <p className="text-sm text-muted-foreground">Loading preferences…</p>
      ) : prefs.isError ? (
        <Alert tone="error">{errorMessage(prefs.error)}</Alert>
      ) : (
        <form
          onSubmit={form.handleSubmit((v) => save.mutate(v))}
          noValidate
          className="flex max-w-md flex-col gap-4"
        >
          {save.isError ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
          {save.isSuccess && !isDirty ? <Alert tone="success">Preferences saved.</Alert> : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Notifications</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                {...form.register("notifyEmail")}
              />
              Email me about price drops and alerts
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                {...form.register("notifyInApp")}
              />
              Show in-app notifications
            </label>
          </fieldset>
          <Field label="Language">
            {(p) => (
              <select
                {...p}
                className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                {...form.register("locale")}
              >
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">हिन्दी (Hindi)</option>
              </select>
            )}
          </Field>
          <Field
            label="Preferred brands"
            error={errors.brands?.message}
            hint="Comma-separated, e.g. Samsung, Apple, OnePlus"
          >
            {(p) => <Input {...p} {...form.register("brands")} />}
          </Field>
          <div>
            <Button type="submit" disabled={!isDirty || save.isPending}>
              {save.isPending ? "Saving…" : "Save preferences"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

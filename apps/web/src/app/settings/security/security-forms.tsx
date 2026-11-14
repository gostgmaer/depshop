"use client";

import { type MessageResponse, type SessionsResponse, changePasswordInput } from "@dealmind/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { ME_KEY, broadcastAuthChange, errorMessage } from "@/lib/auth-hooks";

const SESSIONS_KEY = ["sessions"] as const;

const schema = changePasswordInput
  .innerType()
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ["newPassword"],
    message: "New password must differ from the current password",
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
type Values = z.infer<typeof schema>;

export function ChangePasswordCard() {
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const { errors } = form.formState;

  const change = useMutation({
    mutationFn: ({ confirmPassword: _c, ...values }: Values) =>
      api<MessageResponse>("POST", "/auth/change-password", values),
    onSuccess: () => {
      form.reset();
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  return (
    <Card>
      <CardHeader
        title="Change password"
        description="Changing your password signs out all your other sessions."
      />
      <form
        onSubmit={form.handleSubmit((v) => change.mutate(v))}
        noValidate
        className="flex max-w-md flex-col gap-4"
      >
        {change.isError ? <Alert tone="error">{errorMessage(change.error)}</Alert> : null}
        {change.isSuccess ? <Alert tone="success">{change.data.message}</Alert> : null}
        <Field label="Current password" error={errors.currentPassword?.message}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              {...form.register("currentPassword")}
            />
          )}
        </Field>
        <Field
          label="New password"
          error={errors.newPassword?.message}
          hint="At least 10 characters, with a letter and a number."
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              {...form.register("newPassword")}
            />
          )}
        </Field>
        <Field label="Confirm new password" error={errors.confirmPassword?.message}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              {...form.register("confirmPassword")}
            />
          )}
        </Field>
        <div>
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? "Updating…" : "Update password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });

export function SessionsCard() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api<SessionsResponse>("GET", "/auth/sessions"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/auth/sessions/${id}`),
    onSuccess: (_data, id) => {
      const wasCurrent = sessions.data?.sessions.find((s) => s.id === id)?.current;
      if (wasCurrent) {
        queryClient.setQueryData(ME_KEY, null);
        broadcastAuthChange();
        router.replace("/login");
        router.refresh();
        return;
      }
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  return (
    <Card>
      <CardHeader
        title="Active sessions"
        description="Devices currently signed in to your account."
      />
      {sessions.isPending ? (
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      ) : sessions.isError ? (
        <Alert tone="error">{errorMessage(sessions.error)}</Alert>
      ) : (
        <ul className="divide-y divide-border">
          {revoke.isError ? (
            <li className="pb-3">
              <Alert tone="error">{errorMessage(revoke.error)}</Alert>
            </li>
          ) : null}
          {sessions.data.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {describeAgent(s.userAgent)}
                  {s.current ? (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      This device
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.ipAddress ?? "Unknown IP"} · Last active{" "}
                  {dateTime.format(new Date(s.lastUsedAt))} · Signed in{" "}
                  {dateTime.format(new Date(s.createdAt))}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => revoke.mutate(s.id)}
                disabled={revoke.isPending && revoke.variables === s.id}
              >
                {s.current ? "Sign out" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

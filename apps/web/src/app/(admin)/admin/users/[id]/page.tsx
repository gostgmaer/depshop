"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LogOut, ShieldOff, UserCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  HealthBadge,
  QueryState,
  ReasonDialog,
  StatGrid,
  StatTile,
  num,
} from "@/components/admin/admin-ui";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { errorMessage, useMe } from "@/lib/auth-hooks";
import { formatDate, formatDateTime } from "@/lib/format";
import { admin } from "@/services/admin";

type Action = "suspend" | "reactivate" | "sessions/revoke";
const ACTIONS: Record<
  Action,
  { title: string; confirm: string; description: string; destructive: boolean }
> = {
  suspend: {
    title: "Suspend this user?",
    confirm: "Suspend",
    description:
      "They are signed out of DealMind and can't sign in until reactivated. Their data is kept.",
    destructive: true,
  },
  reactivate: {
    title: "Reactivate this user?",
    confirm: "Reactivate",
    description: "They can sign in again.",
    destructive: false,
  },
  "sessions/revoke": {
    title: "Sign this user out everywhere?",
    confirm: "Sign out",
    description: "Ends every DealMind session; they can sign in again.",
    destructive: true,
  },
};

export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const me = useMe();
  const q = useQuery({ queryKey: ["admin", "user", id], queryFn: () => admin.user(id) });
  const [action, setAction] = useState<Action | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ a, reason }: { a: Action; reason: string }) => admin.userAction(id, a, reason),
    onSuccess: (u, { a }) => {
      qc.setQueryData(["admin", "user", id], u);
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      setAction(null);
      setDone(
        a === "suspend"
          ? "User suspended."
          : a === "reactivate"
            ? "User reactivated."
            : "User signed out of every session.",
      );
    },
  });
  const self = me.data?.id === id;

  return (
    <>
      <Button variant="ghost" size="sm" className="self-start" asChild>
        <Link href="/admin/users">
          <ArrowLeft aria-hidden className="size-4" /> Users
        </Link>
      </Button>
      <QueryState query={q} label="user">
        {(u) => (
          <>
            <PageHeader
              title={u.name || u.email}
              description={u.email}
              eyebrow={
                <div className="flex flex-wrap gap-2">
                  <HealthBadge value={u.status} />
                  <Badge tone={u.role === "ADMIN" ? "ai" : "neutral"}>
                    {u.role === "ADMIN" ? "Admin" : "User"}
                  </Badge>
                  <Badge tone={u.emailVerified ? "success" : "warning"}>
                    {u.emailVerified ? "Email verified" : "Email not verified"}
                  </Badge>
                </div>
              }
              actions={
                self ? undefined : (
                  <>
                    {u.status === "ACTIVE" ? (
                      <Button variant="danger" onClick={() => setAction("suspend")}>
                        <ShieldOff aria-hidden className="size-4" /> Suspend
                      </Button>
                    ) : (
                      <Button onClick={() => setAction("reactivate")}>
                        <UserCheck aria-hidden className="size-4" /> Reactivate
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={!u.activeSessions}
                      onClick={() => setAction("sessions/revoke")}
                    >
                      <LogOut aria-hidden className="size-4" /> Sign out everywhere
                    </Button>
                  </>
                )
              }
            />
            {self ? (
              <Alert>This is your account. Admins can't suspend or sign out themselves here.</Alert>
            ) : null}
            {done ? <Alert tone="success">{done}</Alert> : null}
            <StatGrid>
              <StatTile
                label="Searches (30 days)"
                value={num(u.usage.searches30d)}
                hint={`${num(u.usage.searchesTotal)} in total`}
              />
              <StatTile label="Active alerts" value={num(u.usage.activeAlerts)} />
              <StatTile
                label="Watchlists"
                value={num(u.usage.watchlists)}
                hint={`${num(u.usage.trackedProducts)} tracked products`}
              />
              <StatTile label="AI tokens (30 days)" value={num(u.usage.agentTokens30d)} />
            </StatGrid>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Account" as="h2" />
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">User id</dt>
                  <dd className="font-mono text-xs break-all">{u.id}</dd>
                  <dt className="text-muted-foreground">Joined</dt>
                  <dd>{formatDate(u.createdAt)}</dd>
                  <dt className="text-muted-foreground">Last sign-in</dt>
                  <dd>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Never"}</dd>
                  <dt className="text-muted-foreground">Active sessions</dt>
                  <dd className="tabular">{num(u.activeSessions)}</dd>
                </dl>
              </Card>
              <Card>
                <CardHeader
                  title="Subscription"
                  as="h2"
                  description="Mirror of the payment service; changes happen there, not here."
                />
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd>
                    {u.subscription.plan}
                    {u.subscription.effectivePlan !== u.subscription.plan
                      ? ` (in effect: ${u.subscription.effectivePlan})`
                      : ""}
                  </dd>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>
                    <HealthBadge value={u.subscription.status} />
                  </dd>
                  <dt className="text-muted-foreground">Renews / ends</dt>
                  <dd>
                    {u.subscription.currentPeriodEnd
                      ? formatDate(u.subscription.currentPeriodEnd)
                      : "—"}
                    {u.subscription.cancelAtPeriodEnd ? " (cancels at period end)" : ""}
                  </dd>
                </dl>
              </Card>
            </div>
          </>
        )}
      </QueryState>
      {action ? (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setAction(null);
              m.reset();
            }
          }}
          title={ACTIONS[action].title}
          description={ACTIONS[action].description}
          confirmLabel={ACTIONS[action].confirm}
          destructive={ACTIONS[action].destructive}
          pending={m.isPending}
          error={m.error ? errorMessage(m.error) : null}
          onConfirm={(reason) => m.mutate({ a: action, reason })}
        />
      ) : null}
    </>
  );
}

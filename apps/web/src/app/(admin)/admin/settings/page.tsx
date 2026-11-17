import { KeyRound, Lock, ScrollText, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Settings" };

const RULES = [
  {
    icon: KeyRound,
    title: "Secrets stay in the server environment",
    body: "Marketplace credentials, LLM API keys, payment keys and signing secrets are set as environment variables on the servers. The console shows only whether a credential is present, by name.",
  },
  {
    icon: ShieldCheck,
    title: "Admin access is checked by the API",
    body: "Every admin request is authorized by the API from the signed-in session. The role is never taken from the browser. Admins can't suspend or sign out their own account here.",
  },
  {
    icon: ScrollText,
    title: "Sensitive actions are audited",
    body: "Suspensions, reactivations, sign-outs, connector and AI changes, job retries and catalog corrections need a written reason and are recorded with the admin, target, request id and before/after values.",
  },
  {
    icon: Lock,
    title: "Payments and rankings can't be changed from here",
    body: "Payments are confirmed only by the payment service. Deal rankings and prices come from deterministic services; neither the AI configuration nor affiliate status changes them.",
  },
];

/** Platform administration rules (read-only). Configurable areas link to their pages. */
export default function AdminSettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="How the platform is administered. Configurable settings live on their own pages."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {RULES.map((r) => (
          <Card key={r.title}>
            <div className="flex gap-3">
              <r.icon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <h2 className="font-medium">{r.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{r.body}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title="Configure" />
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {[
            ["/admin/sources", "Connectors: enable, disable, timeouts and rate limits"],
            ["/admin/ai-models", "AI models: provider, model, fallback and monthly budget"],
            ["/admin/affiliates", "Affiliate programs: enable or disable links per marketplace"],
            ["/settings/notifications", "Your own notification preferences"],
          ].map(([href, label]) => (
            <li key={href}>
              <Link href={href!} className="underline underline-offset-2">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

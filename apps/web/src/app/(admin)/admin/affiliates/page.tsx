"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import {
  BarList,
  HealthBadge,
  QueryState,
  StatGrid,
  StatTile,
  num,
} from "@/components/admin/admin-ui";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader, SegmentedControl } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/auth-hooks";
import { rupees } from "@/lib/format";
import { admin } from "@/services/admin";

export default function AdminAffiliatesPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const q = useQuery({
    queryKey: ["admin", "affiliates", days],
    queryFn: () => admin.affiliates(Number(days)),
  });
  const [toggle, setToggle] = useState<{ sourceId: string; name: string; to: boolean } | null>(
    null,
  );
  const m = useMutation({
    mutationFn: (t: { sourceId: string; to: boolean }) => admin.setAffiliate(t.sourceId, t.to),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "affiliates"] });
      setToggle(null);
    },
  });
  return (
    <>
      <PageHeader
        title="Affiliates"
        description="Recorded outbound clicks and partner-reported commissions. Affiliate status never changes deal rankings."
        actions={
          <SegmentedControl
            label="Period"
            value={days}
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
            onChange={setDays}
          />
        }
      />
      <QueryState query={q} label="affiliate data">
        {({ summary: s, programs }) => (
          <>
            <StatGrid>
              <StatTile
                label="Outbound clicks"
                value={num(s.clicks.total)}
                hint={`${num(s.clicks.blocked)} blocked · ${num(s.clicks.signedIn)} signed in`}
              />
              <StatTile
                label="Approved commission"
                value={rupees(s.conversions.APPROVED.commissionPaise)}
                hint={`${num(s.conversions.APPROVED.count)} conversions (partner-reported)`}
              />
              <StatTile
                label="Pending commission"
                value={rupees(s.conversions.PENDING.commissionPaise)}
                hint={`${num(s.conversions.PENDING.count)} awaiting the partner`}
              />
              <StatTile
                label="Paid out"
                value={rupees(s.payouts.PAID.amountPaise)}
                hint={`${num(s.payouts.PENDING.count)} payouts pending`}
              />
            </StatGrid>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Commission figures come only from partner reports or entered statements; DealMind
              never estimates them. Reversed: {rupees(s.conversions.REVERSED.commissionPaise)} ·
              rejected: {rupees(s.conversions.REJECTED.commissionPaise)}.
            </p>
            <Card>
              <CardHeader
                title="Programs"
                description="A program is live only with an approved partner account and configured tracking id."
              />
              <ul className="flex flex-col divide-y divide-border">
                {programs.map((p) => (
                  <li
                    key={p.sourceId}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">
                        {p.marketplace}{" "}
                        <Badge tone={p.linksActive ? "success" : "neutral"}>
                          {p.linksActive ? "Links active" : "Links inactive"}
                        </Badge>
                      </p>
                      <p className="text-sm text-muted-foreground">{p.note}</p>
                      <p className="text-xs text-muted-foreground">
                        Reporting: {p.reporting.toLowerCase().replace(/_/g, " ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <HealthBadge value={p.enabled ? "active" : "disabled"} />
                      <Button
                        variant={p.enabled ? "danger" : "outline"}
                        size="sm"
                        onClick={() =>
                          setToggle({ sourceId: p.sourceId, name: p.marketplace, to: !p.enabled })
                        }
                      >
                        {p.enabled ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Clicks by marketplace" />
                {s.clicks.bySource.length ? (
                  <BarList
                    label="Clicks by marketplace"
                    valueLabel="Clicks"
                    rows={s.clicks.bySource.map((x) => ({
                      key: x.slug,
                      label: x.name,
                      value: x.clicks,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No clicks in this period.</p>
                )}
              </Card>
              <Card>
                <CardHeader title="Clicks by category" />
                {s.clicks.byCategory.length ? (
                  <BarList
                    label="Clicks by category"
                    valueLabel="Clicks"
                    rows={s.clicks.byCategory.map((x) => ({
                      key: x.category,
                      label: x.category,
                      value: x.clicks,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No clicks in this period.</p>
                )}
              </Card>
            </div>
          </>
        )}
      </QueryState>
      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(o) => {
          if (!o) {
            setToggle(null);
            m.reset();
          }
        }}
        title={
          toggle ? `${toggle.to ? "Enable" : "Disable"} affiliate links for ${toggle.name}?` : ""
        }
        description={
          <>
            {toggle?.to
              ? "Links carry the affiliate tag only if the program is approved and configured."
              : "Buy links go straight to the marketplace without a tag."}
            {m.error ? <Alert tone="error">{errorMessage(m.error)}</Alert> : null}
          </>
        }
        confirmLabel={toggle?.to ? "Enable" : "Disable"}
        pending={m.isPending}
        onConfirm={() => toggle && m.mutate(toggle)}
      />
    </>
  );
}

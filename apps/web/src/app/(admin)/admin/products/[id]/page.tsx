"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Pencil, Power } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  HealthBadge,
  QueryState,
  ReasonDialog,
  TableWrap,
  td,
  th,
} from "@/components/admin/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, PageHeader } from "@/components/ui/misc";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/auth-hooks";
import { STOCK_LABEL, formatDateTime, percent, rupees, variantSummary } from "@/lib/format";
import { type AdminProductDetail, admin } from "@/services/admin";

function CorrectDialog({ product, onClose }: { product: AdminProductDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["admin", "categories"], queryFn: admin.categories });
  const [name, setName] = useState(product.name);
  const [brand, setBrand] = useState(product.brand);
  const [categoryId, setCategoryId] = useState(product.category?.id ?? "");
  const [reason, setReason] = useState("");
  const changes: Record<string, unknown> = {};
  if (name.trim() !== product.name) changes.name = name.trim();
  if (brand.trim() !== product.brand) changes.brand = brand.trim();
  if (categoryId !== (product.category?.id ?? "")) changes.categoryId = categoryId || null;
  const m = useMutation({
    mutationFn: () => admin.updateProduct(product.id, { ...changes, reason: reason.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "product", product.id] });
      void qc.invalidateQueries({ queryKey: ["admin", "products"] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Correct product"
        description="Fixes the canonical record. Offers keep their marketplace data."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={2}
                maxLength={300}
                required
              />
            )}
          </Field>
          <Field label="Brand">
            {(p) => (
              <Input
                {...p}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                maxLength={100}
                required
              />
            )}
          </Field>
          <Field label="Category">
            {(p) => (
              <NativeSelect
                {...p}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">None</option>
                {(cats.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Reason (recorded in the audit log)">
            {(p) => (
              <Input
                {...p}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                maxLength={500}
                required
              />
            )}
          </Field>
          {m.error ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(m.error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={!Object.keys(changes).length || reason.trim().length < 3 || m.isPending}
            >
              {m.isPending ? "Saving…" : "Save correction"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminProductPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "product", id], queryFn: () => admin.product(id) });
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const toggle = useMutation({
    mutationFn: ({ isActive, reason }: { isActive: boolean; reason: string }) =>
      admin.updateProduct(id, { isActive, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "product", id] });
      void qc.invalidateQueries({ queryKey: ["admin", "products"] });
      setToggling(false);
    },
  });
  return (
    <>
      <Button variant="ghost" size="sm" className="self-start" asChild>
        <Link href="/admin/products">
          <ArrowLeft aria-hidden className="size-4" /> Products
        </Link>
      </Button>
      <QueryState query={q} label="product">
        {(p) => (
          <>
            <PageHeader
              title={p.name}
              description={`${p.brand} · ${p.category?.name ?? "No category"}`}
              eyebrow={<HealthBadge value={p.isActive ? "active" : "inactive"} />}
              actions={
                <>
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    <Pencil aria-hidden className="size-4" /> Correct
                  </Button>
                  <Button
                    variant={p.isActive ? "danger" : "default"}
                    onClick={() => setToggling(true)}
                  >
                    <Power aria-hidden className="size-4" />{" "}
                    {p.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </>
              }
            />
            <Card>
              <CardHeader title="Variants" />
              <ul className="flex flex-col divide-y divide-border text-sm">
                {p.variants.map((v) => (
                  <li key={v.id} className="py-2">
                    <p>{variantSummary(v.attributes).join(" · ") || v.variantKey}</p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        v.sku && `SKU ${v.sku}`,
                        v.gtin && `GTIN ${v.gtin}`,
                        v.mpn && `MPN ${v.mpn}`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "No identifiers"}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader
                title="Offers and provenance"
                description="As observed on each marketplace; read-only."
              />
              {p.offers.length ? (
                <TableWrap label="Offers">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className={th}>
                          Marketplace
                        </th>
                        <th scope="col" className={`${th} text-right`}>
                          Price
                        </th>
                        <th scope="col" className={th}>
                          Stock
                        </th>
                        <th scope="col" className={th}>
                          Match
                        </th>
                        <th scope="col" className={th}>
                          Observed
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.offers.map((o) => (
                        <tr key={o.id} className="border-t border-border">
                          <td className={td}>
                            <a
                              href={o.productUrl}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                            >
                              {o.source.name} <ExternalLink aria-hidden className="size-3" />
                              <span className="sr-only">(opens the listing)</span>
                            </a>
                            {o.source.isSample ? (
                              <Badge tone="warning" className="ml-1">
                                Sample
                              </Badge>
                            ) : null}
                            <p className="max-w-xs truncate text-xs text-muted-foreground">
                              {o.title}
                            </p>
                          </td>
                          <td className={`${td} text-right tabular whitespace-nowrap`}>
                            {rupees(o.sellingPricePaise)}
                            {o.mrpPaise ? (
                              <p className="text-xs text-muted-foreground">
                                MRP {rupees(o.mrpPaise)}
                              </p>
                            ) : null}
                          </td>
                          <td className={td}>{STOCK_LABEL[o.stockStatus] ?? o.stockStatus}</td>
                          <td className={`${td} whitespace-nowrap`}>
                            {o.matchMethod.toLowerCase().replace(/_/g, " ")}
                            <p className="text-xs text-muted-foreground">
                              {percent(o.matchConfidence)} confidence
                            </p>
                          </td>
                          <td className={`${td} whitespace-nowrap`}>
                            {formatDateTime(o.observedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : (
                <p className="text-sm text-muted-foreground">No offers.</p>
              )}
            </Card>
            {editing ? <CorrectDialog product={p} onClose={() => setEditing(false)} /> : null}
            {toggling ? (
              <ReasonDialog
                open
                onOpenChange={(o) => {
                  if (!o) {
                    setToggling(false);
                    toggle.reset();
                  }
                }}
                title={p.isActive ? "Deactivate this product?" : "Activate this product?"}
                description={
                  p.isActive
                    ? "It stops appearing in the catalog. Offers and history are kept."
                    : "It appears in the catalog again."
                }
                confirmLabel={p.isActive ? "Deactivate" : "Activate"}
                destructive={p.isActive}
                pending={toggle.isPending}
                error={toggle.error ? errorMessage(toggle.error) : null}
                onConfirm={(reason) => toggle.mutate({ isActive: !p.isActive, reason })}
              />
            ) : null}
          </>
        )}
      </QueryState>
    </>
  );
}

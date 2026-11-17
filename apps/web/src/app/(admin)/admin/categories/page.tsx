"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Power } from "lucide-react";
import { useState } from "react";
import {
  HealthBadge,
  QueryState,
  ReasonDialog,
  TableWrap,
  num,
  td,
  th,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/misc";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/auth-hooks";
import { type AdminCategory, admin } from "@/services/admin";

function RenameDialog({ category, onClose }: { category: AdminCategory; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(category.name);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () =>
      admin.updateCategory(category.id, { name: name.trim(), reason: reason.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "categories"] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Rename category"
        description={`Slug ${category.slug} stays the same (links keep working).`}
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
                maxLength={100}
                required
              />
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
              disabled={
                name.trim() === category.name ||
                name.trim().length < 2 ||
                reason.trim().length < 3 ||
                m.isPending
              }
            >
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminCategoriesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "categories"], queryFn: admin.categories });
  const [renaming, setRenaming] = useState<AdminCategory | null>(null);
  const [toggling, setToggling] = useState<AdminCategory | null>(null);
  const m = useMutation({
    mutationFn: ({ c, reason }: { c: AdminCategory; reason: string }) =>
      admin.updateCategory(c.id, { isActive: !c.isActive, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "categories"] });
      setToggling(null);
    },
  });
  return (
    <>
      <PageHeader
        title="Categories"
        description="The catalog's category tree. Deactivated categories are hidden from shoppers; their products are kept."
      />
      <QueryState query={q} label="categories">
        {(cats) => {
          const byParent = new Map<string | null, AdminCategory[]>();
          for (const c of cats) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
          const ordered: { c: AdminCategory; depth: number }[] = [];
          const walk = (parent: string | null, depth: number) => {
            for (const c of byParent.get(parent) ?? []) {
              ordered.push({ c, depth });
              walk(c.id, depth + 1);
            }
          };
          walk(null, 0);
          return (
            <Card>
              <TableWrap label="Categories">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th scope="col" className={th}>
                        Category
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Products
                      </th>
                      <th scope="col" className={th}>
                        Status
                      </th>
                      <th scope="col" className={th}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map(({ c, depth }) => (
                      <tr key={c.id} className="border-t border-border">
                        <td className={td} style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}>
                          {c.name}
                          <p className="text-xs text-muted-foreground">{c.slug}</p>
                        </td>
                        <td className={`${td} text-right tabular`}>{num(c.products)}</td>
                        <td className={td}>
                          <HealthBadge value={c.isActive ? "active" : "inactive"} />
                        </td>
                        <td className={td}>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setRenaming(c)}
                              aria-label={`Rename ${c.name}`}
                            >
                              <Pencil aria-hidden className="size-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant={c.isActive ? "danger" : "outline"}
                              onClick={() => setToggling(c)}
                              aria-label={`${c.isActive ? "Deactivate" : "Activate"} ${c.name}`}
                            >
                              <Power aria-hidden className="size-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          );
        }}
      </QueryState>
      {renaming ? <RenameDialog category={renaming} onClose={() => setRenaming(null)} /> : null}
      {toggling ? (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setToggling(null);
              m.reset();
            }
          }}
          title={`${toggling.isActive ? "Deactivate" : "Activate"} ${toggling.name}?`}
          description={
            toggling.isActive
              ? "Shoppers stop seeing this category. Products are kept."
              : "Shoppers see this category again."
          }
          confirmLabel={toggling.isActive ? "Deactivate" : "Activate"}
          destructive={toggling.isActive}
          pending={m.isPending}
          error={m.error ? errorMessage(m.error) : null}
          onConfirm={(reason) => m.mutate({ c: toggling, reason })}
        />
      ) : null}
    </>
  );
}

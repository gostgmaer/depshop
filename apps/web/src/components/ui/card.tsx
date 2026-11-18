import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface p-5 shadow-(--shadow-card) sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  as: Heading = "h2",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  as?: "h2" | "h3";
}) {
  return (
    // The action wraps below the title when there is no room beside it (small phones).
    <header className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1 basis-60">
        <Heading className="text-base font-semibold tracking-tight">{title}</Heading>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

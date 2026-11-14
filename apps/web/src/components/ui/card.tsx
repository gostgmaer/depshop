import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-xl border border-border bg-background p-5 sm:p-6", className)}
      {...props}
    />
  );
}

export function CardHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="mb-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </header>
  );
}

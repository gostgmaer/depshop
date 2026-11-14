import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = {
  error: "border-danger/30 bg-danger/10 text-danger",
  success: "border-primary/30 bg-primary/10 text-foreground",
  info: "border-border bg-muted text-foreground",
} as const;

export function Alert({
  tone = "info",
  children,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border px-3 py-2.5 text-sm", tones[tone])}
    >
      {children}
    </div>
  );
}

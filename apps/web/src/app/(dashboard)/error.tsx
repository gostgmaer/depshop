"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Route-level error boundary: the shell stays usable, the page can retry. */
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-4 rounded-xl border border-danger/25 bg-danger-soft p-6"
    >
      <p className="flex items-center gap-2 font-medium text-danger">
        <AlertTriangle aria-hidden className="size-5" /> This page could not be loaded.
      </p>
      <p className="text-sm text-muted-foreground">
        Your data is safe. Try again, or come back in a moment.
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { setup } from "@/services";

/** On the sign-in page, only while no administrator exists yet. */
export function SetupNotice() {
  const status = useQuery({ queryKey: ["setup"], queryFn: setup.status, retry: false });
  if (!status.data?.required) return null;
  return (
    <Alert tone="info">
      First run: no administrator yet.{" "}
      <Link href="/setup" className="font-medium underline underline-offset-4">
        Set up the administrator account
      </Link>
    </Alert>
  );
}

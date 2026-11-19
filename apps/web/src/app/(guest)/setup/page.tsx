import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "First-run setup" };

export default function SetupPage() {
  return (
    <AuthShell
      title="Set up the administrator"
      subtitle="The first account created here becomes DealMind's administrator."
    >
      <SetupForm />
    </AuthShell>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { SetupNotice } from "@/components/auth/setup-notice";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to DealMind."
      footer={
        <>
          New here?{" "}
          <Link
            href="/register"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Create an account
          </Link>
        </>
      }
    >
      <SetupNotice />
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}

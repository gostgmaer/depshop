import type { Metadata } from "next";
import { ChangePasswordCard, SessionsCard } from "./security-forms";

export const metadata: Metadata = { title: "Security" };

export default function SecurityPage() {
  return (
    <>
      <ChangePasswordCard />
      <SessionsCard />
    </>
  );
}

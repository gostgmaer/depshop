import type { Metadata } from "next";
import { DeleteAccountCard, ExportDataCard } from "./privacy-forms";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacySettingsPage() {
  return (
    <>
      <ExportDataCard />
      <DeleteAccountCard />
    </>
  );
}

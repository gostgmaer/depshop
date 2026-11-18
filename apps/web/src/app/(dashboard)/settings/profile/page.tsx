import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { EmailCard, PreferencesCard, ProfileCard } from "./profile-forms";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <>
      <ProfileCard />
      <EmailCard />
      <PreferencesCard />
      <Card>
        <CardHeader
          title="Introduction"
          description="The short tour of searching, comparing, genuine discounts and price alerts."
        />
        <Link
          href="/dashboard?tour=1"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Show the introduction again
        </Link>
      </Card>
    </>
  );
}

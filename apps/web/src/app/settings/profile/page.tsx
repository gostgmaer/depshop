import type { Metadata } from "next";
import { EmailCard, PreferencesCard, ProfileCard } from "./profile-forms";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <>
      <ProfileCard />
      <EmailCard />
      <PreferencesCard />
    </>
  );
}

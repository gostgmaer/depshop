import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy notice",
  description:
    "What DealMind AI stores about you, why, for how long, and how to export or delete it.",
  alternates: { canonical: "/privacy" },
};

/**
 * Privacy notice (Phase 7.1). Describes only what the code does. The
 * operator's contact/grievance details come from configuration and are shown
 * as missing until set (they must be set before launch; see
 * docs/PRODUCTION_READINESS.md). This is not a compliance certification.
 */
const RETENTION: [string, string][] = [
  ["Account profile (name, email, role)", "Until you delete your account."],
  ["Sign-in sessions (device, browser, IP address)", "While the session is active, then 30 days."],
  ["Search history (queries, filters, results)", "365 days, or until you delete your account."],
  [
    "Watchlists and price alerts",
    "Until you delete them or your account. Alert check history: 90 days.",
  ],
  ["Notifications", "365 days. Email/push delivery records: 90 days."],
  [
    "Affiliate link clicks",
    "Identifiers (hashed IP, referrer) cleared after 30 days; clicks without a purchase deleted after 13 months; clicks with a reported purchase kept for partner reconciliation, without your account once it is deleted.",
  ],
  [
    "Subscription status and payment notifications",
    "While your account exists; payment-service event records are kept without your account after deletion (financial records). Card and bank details are never held by DealMind.",
  ],
  [
    "Security audit log",
    "Kept for security investigations; after deletion it no longer names you.",
  ],
];

export default function PrivacyPage() {
  const contact = process.env.PRIVACY_CONTACT_EMAIL;
  const operator = process.env.PRIVACY_OPERATOR_NAME;
  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Privacy notice</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          How DealMind AI uses your personal data. DealMind is a single service for individual
          shoppers in India.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Who is responsible</h2>
        {operator && contact ? (
          <p>
            {operator} operates DealMind AI. For privacy questions, to exercise your rights or to
            raise a grievance, write to{" "}
            <a className="underline" href={`mailto:${contact}`}>
              {contact}
            </a>
            .
          </p>
        ) : (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-warning">
            The operator&apos;s name and privacy contact have not been configured for this
            installation yet.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">What we collect and why</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Account:</strong> your name and email, to sign you in and contact you about your
            account. Your password is held by the shared EasyDev sign-in service, not by DealMind.
          </li>
          <li>
            <strong>Searches, watchlists and alerts:</strong> to find and compare products, track
            prices and notify you of price changes you asked for.
          </li>
          <li>
            <strong>Sessions:</strong> device, browser and IP address, to keep you signed in and to
            show and end your active sessions.
          </li>
          <li>
            <strong>Notifications:</strong> what we sent you and whether it was delivered.
          </li>
          <li>
            <strong>Subscriptions:</strong> your plan and its status. Payments are processed by the
            payment provider; DealMind never sees card or bank details.
          </li>
          <li>
            <strong>Affiliate clicks:</strong> when you choose &quot;Buy&quot;, which offer you
            opened, a salted hash of your IP address, your device type and the referring host, to
            attribute partner commissions. Affiliate relationships never change rankings.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Who receives data</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Shared EasyDev services that run sign-in, email delivery and payments for DealMind.
          </li>
          <li>
            The AI model provider configured by the operator receives the text of your search to
            understand it. It does not receive your name or email.
          </li>
          <li>
            Marketplaces you choose to visit receive your visit directly from your browser;
            affiliate partners report purchases, not your identity.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">How long we keep it</h2>
        <table className="w-full text-sm">
          <caption className="sr-only">Retention periods</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Data
              </th>
              <th scope="col" className="py-2 font-medium">
                Kept for
              </th>
            </tr>
          </thead>
          <tbody>
            {RETENTION.map(([what, how]) => (
              <tr key={what} className="border-t border-border align-top">
                <th scope="row" className="py-2 pr-4 font-normal">
                  {what}
                </th>
                <td className="py-2">{how}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Your choices and rights</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>See and download your data:</strong>{" "}
            <Link className="underline" href="/settings/privacy">
              Settings → Privacy
            </Link>
            .
          </li>
          <li>
            <strong>Correct it:</strong> change your name in{" "}
            <Link className="underline" href="/settings/profile">
              Settings → Profile
            </Link>
            .
          </li>
          <li>
            <strong>Delete your account:</strong>{" "}
            <Link className="underline" href="/settings/privacy">
              Settings → Privacy
            </Link>
            . Your shared EasyDev sign-in is separate; ask the contact above to remove it.
          </li>
          <li>
            <strong>Stop messages:</strong> email, push and in-app notifications can be turned off
            in{" "}
            <Link className="underline" href="/settings/notifications">
              Settings → Notifications
            </Link>
            , and every email has an unsubscribe link.
          </li>
          <li>
            <strong>Sign out everywhere:</strong>{" "}
            <Link className="underline" href="/settings/security">
              Settings → Security
            </Link>
            .
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          India&apos;s Digital Personal Data Protection Act, 2023 and its rules give you rights over
          your personal data, including to access, correct and erase it, to have a grievance
          addressed, and to nominate someone to exercise your rights. Use the contact above for
          anything the settings pages don&apos;t cover.
        </p>
      </section>
    </main>
  );
}

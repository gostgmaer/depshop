import type { FastifyBaseLogger } from "fastify";
import type { EmailMessage, EmailTransport } from "./email-transport.js";

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(
  heading: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#15803d;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#555">Or paste this link into your browser:<br>${escapeHtml(action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}
<p style="margin:32px 0 0;font-size:12px;color:#777">DealMind AI · You received this because of activity on your account.</p>
</body></html>`;
}

const text = (heading: string, paragraphs: string[], action?: { label: string; url: string }) =>
  [heading, "", ...paragraphs, ...(action ? ["", `${action.label}: ${action.url}`] : [])].join(
    "\n",
  );

/**
 * Builds and sends DealMind's transactional emails.
 *
 * `send` never throws: delivery failures are logged. Callers fire-and-forget
 * so that response times do not reveal whether an email was sent (account
 * enumeration). TODO(phase-7): move delivery onto a BullMQ queue with retries.
 */
export class EmailService {
  constructor(
    private readonly transport: EmailTransport,
    private readonly appUrl: string,
    private readonly log: Pick<FastifyBaseLogger, "error">,
  ) {}

  private link(path: string, token?: string): string {
    const url = new URL(path, this.appUrl);
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }

  private async send(message: EmailMessage): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (err) {
      this.log.error({ err, subject: message.subject }, "Email delivery failed");
    }
  }

  private compose(
    to: string,
    subject: string,
    heading: string,
    paragraphs: string[],
    action?: { label: string; url: string },
  ) {
    return this.send({
      to,
      subject,
      text: text(heading, paragraphs, action),
      html: layout(heading, paragraphs, action),
    });
  }

  sendVerification(to: string, name: string, token: string, ttlHours: number) {
    return this.compose(
      to,
      "Verify your DealMind email",
      `Welcome, ${name}`,
      [
        "Please confirm your email address to finish setting up your DealMind account.",
        `This link expires in ${ttlHours} hours and can be used once.`,
      ],
      { label: "Verify email", url: this.link("/verify-email", token) },
    );
  }

  /** Sent when someone tries to register with an email that already has an account. */
  sendAccountExists(to: string) {
    return this.compose(
      to,
      "Someone tried to create a DealMind account with your email",
      "You already have an account",
      [
        "Someone (hopefully you) tried to sign up for DealMind with this email address, which already has an account.",
        "If this was you, sign in instead, or reset your password if you have forgotten it. If it wasn't you, you can ignore this email; your account is unchanged.",
      ],
      { label: "Reset password", url: this.link("/forgot-password") },
    );
  }

  sendPasswordReset(to: string, token: string, ttlMinutes: number) {
    return this.compose(
      to,
      "Reset your DealMind password",
      "Reset your password",
      [
        "We received a request to reset the password for your DealMind account.",
        `This link expires in ${ttlMinutes} minutes and can be used once. If you didn't ask for this, ignore this email; your password will not change.`,
      ],
      { label: "Choose a new password", url: this.link("/reset-password", token) },
    );
  }

  sendPasswordChanged(to: string) {
    return this.compose(
      to,
      "Your DealMind password was changed",
      "Your password was changed",
      [
        "The password for your DealMind account was just changed, and other signed-in sessions were signed out.",
        "If you didn't do this, reset your password immediately and review your active sessions.",
      ],
      { label: "Review security settings", url: this.link("/settings/security") },
    );
  }
}

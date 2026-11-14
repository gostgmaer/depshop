import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Delivery mechanism. Swap implementations without touching business logic. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

/** Real SMTP delivery (Mailpit locally, a real provider in production). */
export class SmtpEmailTransport implements EmailTransport {
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? "" } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.config.from, ...message });
  }
}

/**
 * Development fallback when no SMTP server is configured. Logs only the
 * recipient and subject: email bodies contain single-use secrets (verification
 * and reset links) and must never be written to logs.
 */
export class ConsoleEmailTransport implements EmailTransport {
  constructor(private readonly log: Pick<FastifyBaseLogger, "info">) {}

  send(message: EmailMessage): Promise<void> {
    this.log.info(
      { to: message.to, subject: message.subject },
      "Email not sent (EMAIL_TRANSPORT=console). Use Mailpit (EMAIL_TRANSPORT=smtp) to read emails.",
    );
    return Promise.resolve();
  }
}

/** Test transport: captures messages in memory. */
export class MemoryEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

import { describe, expect, it, vi } from "vitest";
import { EmailService } from "./email-service.js";
import { type EmailTransport, MemoryEmailTransport } from "./email-transport.js";

describe("EmailService", () => {
  it("builds verification links on APP_URL and escapes user-controlled HTML", async () => {
    const mail = new MemoryEmailTransport();
    const svc = new EmailService(mail, "https://dealmind.example", { error: vi.fn() });
    await svc.sendVerification("a@b.co", "<script>alert(1)</script>", "tok_123", 24);
    const [m] = mail.sent;
    expect(m?.text).toContain("https://dealmind.example/verify-email?token=tok_123");
    expect(m?.html).not.toContain("<script>");
    expect(m?.html).toContain("&#60;script&#62;");
  });

  it("never throws when delivery fails, and logs instead", async () => {
    const failing: EmailTransport = { send: () => Promise.reject(new Error("smtp down")) };
    const error = vi.fn();
    const svc = new EmailService(failing, "http://localhost:3000", { error });
    await expect(svc.sendPasswordReset("a@b.co", "tok", 30)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });
});

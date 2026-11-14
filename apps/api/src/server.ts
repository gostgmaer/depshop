import { createPrismaClient } from "@dealmind/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import {
  ConsoleEmailTransport,
  type EmailTransport,
  SmtpEmailTransport,
} from "./modules/email/email-transport.js";

const env = loadEnv();
const prisma = createPrismaClient({ url: env.DATABASE_URL });

const emailTransport: EmailTransport =
  env.EMAIL_TRANSPORT === "smtp" && env.SMTP_HOST
    ? new SmtpEmailTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.EMAIL_FROM,
      })
    : new ConsoleEmailTransport({
        info: (obj: object, msg?: string) =>
          console.warn(`[email] ${msg ?? ""}`, JSON.stringify(obj)),
      });

const app = await buildApp({
  env,
  prisma,
  emailTransport,
  healthChecks: {
    database: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
  },
  ...(env.NODE_ENV === "development"
    ? { logger: { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } } }
    : {}),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.fatal(err, "Failed to start server");
  await prisma.$disconnect();
  process.exit(1);
}

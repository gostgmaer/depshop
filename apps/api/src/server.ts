import { createPrismaClient } from "@dealmind/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { PrismaUserStore } from "./modules/users/user-store.js";

const env = loadEnv();
const prisma = createPrismaClient({ url: env.DATABASE_URL });

const app = await buildApp({
  env,
  userStore: new PrismaUserStore(prisma),
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

/**
 * Registers DealMind's paid plans with the shared payment service and stores
 * the provider plan ids (pnpm --filter @dealmind/api billing:sync-plans).
 * Idempotent; prints only plan keys and ids (no secrets).
 */
import {
  EasyDevPaymentsProvider,
  EntitlementService,
  provisionProviderPlans,
} from "@dealmind/billing";
import { createPrismaClient } from "@dealmind/db";
import { loadEnv } from "../config/env.js";

const env = loadEnv(process.env);
if (env.BILLING_PROVIDER !== "easydev-payments") {
  process.stderr.write("BILLING_PROVIDER must be easydev-payments to provision plans.\n");
  process.exit(1);
}
const prisma = createPrismaClient({ url: env.DATABASE_URL });
try {
  const ids = await provisionProviderPlans(
    prisma,
    new EntitlementService(prisma),
    new EasyDevPaymentsProvider({
      baseUrl: env.PAYMENT_SERVICE_URL!,
      apiKey: env.PAYMENT_SERVICE_API_KEY!,
      tenantId: env.PAYMENT_TENANT_ID,
      applicationId: env.PAYMENT_APPLICATION_ID,
    }),
  );
  for (const [key, id] of Object.entries(ids)) process.stdout.write(`${key} -> ${id}\n`);
} finally {
  await prisma.$disconnect();
}

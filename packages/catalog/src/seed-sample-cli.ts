/** `pnpm --filter @dealmind/catalog seed:sample` — dev-only, labeled sample data. */
/* eslint-disable no-console -- CLI script: stdout is its interface */
import { createPrismaClient } from "@dealmind/db";
import { seedSampleCatalog } from "./sample-data.js";

const prisma = createPrismaClient();
try {
  const s = await seedSampleCatalog(prisma);
  console.log(
    `Sample catalog (NOT real offers): ${s.imported} listings imported, ${s.productsCreated} products, ` +
      `${s.variantsCreated} variants, ${s.offersCreated} new offers, ${s.offersUpdated} updated, ` +
      `${s.sentToReview} sent to review, ${s.rejected} rejected.`,
  );
  if (s.rejected)
    console.error(
      JSON.stringify(
        s.outcomes.filter((o) => o.status === "rejected"),
        null,
        2,
      ),
    );
} finally {
  await prisma.$disconnect();
}

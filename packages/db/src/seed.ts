/** CLI entry: `pnpm db:seed`. See seed-data.ts for what is (and is not) seeded. */
import { createPrismaClient } from "./index.js";
import { seedReferenceData } from "./seed-data.js";

const prisma = createPrismaClient();

seedReferenceData(prisma)
  .then(({ plans, sources, categories }) => {
    console.warn(
      `Seeded ${plans} plans, ${sources} shopping sources (all disabled), ${categories} categories.`,
    );
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

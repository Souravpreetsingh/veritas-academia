import { PrismaClient } from "@prisma/client";
import { requireEnv } from "@/lib/env";

// PrismaClient is instantiated once per process. On the Next.js dev server the
// module can be re-evaluated on hot reload, so the instance is cached on
// globalThis to avoid exhausting the connection pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  requireEnv("DATABASE_URL");
  return new PrismaClient();
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

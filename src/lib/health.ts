import { prisma } from "@/lib/db";

// Database liveness probe for the platform health check.
//
// The query is deliberately trivial ("SELECT 1") and bounded so a hung
// database can never hang the health endpoint. Failures return false; the
// route above maps that to a non-2xx response, which tells the platform the
// instance is not ready to receive traffic.

export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** True when the database answers a trivial query within the timeout. */
export async function databaseHealthy(
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("database health check timed out")),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

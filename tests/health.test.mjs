import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import { databaseHealthy, HEALTH_CHECK_TIMEOUT_MS } from "../src/lib/health.ts";

// The platform health check must succeed only when the database is reachable,
// and must fail closed (not hang) when the probe exceeds its budget.

test.after(async () => {
  await prisma.$disconnect();
});

test("health probe succeeds against the test database", async () => {
  assert.equal(typeof HEALTH_CHECK_TIMEOUT_MS, "number");
  assert.ok(HEALTH_CHECK_TIMEOUT_MS > 0 && HEALTH_CHECK_TIMEOUT_MS <= 5_000);
  assert.equal(await databaseHealthy(), true);
});

test("health probe fails closed when the budget is exhausted", async () => {
  assert.equal(await databaseHealthy(0), false);
});

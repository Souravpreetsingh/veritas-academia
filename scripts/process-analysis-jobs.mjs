import { prisma } from "../src/lib/db.ts";
import {
  findDueAnalysisJobIds,
  processAnalysisJob,
} from "../src/lib/analysis/jobs.ts";

// One bounded pass over the database-backed analysis queue.
//
// There is no in-memory timer and no scheduler inside the Next.js process. Run
// this from cron / a platform scheduler, or manually in development:
//
//   npm run analysis:worker
//
// It performs at most ANALYSIS_WORKER_BATCH (default 10) due jobs and exits.
// Concurrent runs are safe: every transition is a conditional claim. Nothing
// here writes document text, provider payloads, or credentials to the console.
const rawLimit = Number(process.env.ANALYSIS_WORKER_BATCH ?? "10");
const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 50)) : 10;

const ids = await findDueAnalysisJobIds({ limit });
console.log(`[analysis-worker] ${ids.length} due job(s) (batch limit ${limit})`);

let failures = 0;
for (const id of ids) {
  try {
    const outcome = await processAnalysisJob({ jobId: id });
    console.log(`[analysis-worker] ${id}: ${outcome.outcome}`);
  } catch (error) {
    failures += 1;
    const name = error instanceof Error ? error.name : "Error";
    // Never print raw error messages: storage/provider errors may contain
    // sensitive metadata. The safe state is persisted on the job.
    console.error(`[analysis-worker] ${id}: worker_error (${name})`);
  }
}

await prisma.$disconnect();
if (failures > 0) process.exitCode = 1;

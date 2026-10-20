import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Standalone test runner. Uses the built-in node:test runner and a DEDICATED
// test database, so the development database is never touched.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DATABASE_URL = "file:./test.db";

// Safety: refuse to run if the configured URL is not unmistakably a test DB.
if (!TEST_DATABASE_URL.endsWith("test.db")) {
  console.error("Refusing to run tests: DATABASE_URL is not a dedicated test database.");
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: "test" };

function run(command) {
  execSync(command, { cwd: projectRoot, env, stdio: "inherit" });
}

console.log("• Preparing dedicated test database (prisma/test.db)");
run("npx prisma db push --skip-generate --force-reset --accept-data-loss");

console.log("• Running node:test suites");
// --test-concurrency=1 runs test files sequentially so the two database-backed
// suites never contend for the shared prisma/test.db file.
run('node --import ./scripts/ts-resolve-hook.mjs --test-concurrency=1 --test "tests/**/*.test.mjs"');

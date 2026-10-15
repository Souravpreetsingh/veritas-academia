#!/usr/bin/env node
// Promotes an existing user to ADMIN.
//
// This is the only supported way to grant administrator privileges in Phase 2.
// It must be run locally with database access and an explicit confirmation flag,
// so that no public registration or API path can ever create an administrator.
//
// Usage:
//   npm run grant-admin -- --email=admin@example.com --confirm
//   npm run revoke-admin -- --email=admin@example.com --confirm   (see scripts/revoke-admin.mjs)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function readArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : undefined;
}

async function main() {
  const email = readArg("email");
  const confirmed = process.argv.includes("--confirm");

  if (!email) {
    console.error("Error: --email=<address> is required.");
    process.exitCode = 1;
    return;
  }
  if (!confirmed) {
    console.error("Error: refusing to change roles without --confirm.");
    console.error("Re-run as: npm run grant-admin -- --email=" + email + " --confirm");
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user) {
    console.error(`Error: no user found with email ${normalizedEmail}.`);
    console.error("The user must register first; administrators are never seeded automatically.");
    process.exitCode = 1;
    return;
  }

  if (user.role === "ADMIN") {
    console.log(`No change: ${normalizedEmail} is already an ADMIN.`);
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: "ADMIN" },
  });

  console.log(`Granted ADMIN to ${updated.email} (${updated.name}).`);
}

main()
  .catch((error) => {
    console.error("Failed to grant admin:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

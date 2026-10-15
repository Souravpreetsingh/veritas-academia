import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword, checkPasswordPolicy, normalizeEmail } from "@/lib/password";

export const runtime = "nodejs";

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// Public registration intentionally creates STUDENT accounts only. It is
// impossible for a visitor to self-assign INSTRUCTOR or ADMIN: the role is
// never read from the request body and defaults to STUDENT in the database.
export async function POST(request: Request) {
  let body: { name?: unknown; email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request body.");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const rawEmail = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (name.length < 2 || name.length > 100) {
    return fail("Please enter your full name (2–100 characters).");
  }

  const email = normalizeEmail(rawEmail);
  if (!email.valid || !email.normalized) {
    return fail("Enter a valid email address.");
  }

  const policy = checkPasswordPolicy(password);
  if (!policy.valid) {
    return fail(policy.error ?? "Password does not meet requirements.");
  }

  try {
    const passwordHash = await hashPassword(password);

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: email.normalized as string,
          passwordHash,
          role: "STUDENT",
        },
      });
      await tx.studentProfile.create({ data: { userId: user.id } });
    });

    return NextResponse.json({ ok: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return fail("An account with this email already exists.", 409);
    }
    console.error("Registration failed:", error);
    return fail("Registration failed. Please try again later.", 500);
  }
}

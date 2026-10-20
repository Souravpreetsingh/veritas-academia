import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword, checkPasswordPolicy, normalizeEmail } from "@/lib/password";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";
import { guardRegistration } from "@/lib/rate-limit-guard";

export const runtime = "nodejs";

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// Public registration intentionally creates STUDENT accounts only. It is
// impossible for a visitor to self-assign INSTRUCTOR or ADMIN: the role is
// never read from the request body and defaults to STUDENT in the database.
export async function POST(request: Request) {
  // Abuse protection first: malformed or hostile requests still consume the
  // source bucket, so a script cannot rotate emails to avoid the limit.
  const limited = await guardRegistration(request);
  if (limited) return limited;

  const parsed = await readJsonBodyWithLimit(request.body, REQUEST_BODY_LIMITS.jsonBytes);
  if (!parsed.ok) {
    return fail(
      parsed.tooLarge ? "The request body is too large." : "Invalid request body.",
      parsed.tooLarge ? 413 : 400,
    );
  }
  const body = (parsed.value ?? {}) as { name?: unknown; email?: unknown; password?: unknown };

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

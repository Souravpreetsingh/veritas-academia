import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS, type Role } from "@/lib/domain";
import { evaluateInstructorEligibility } from "@/lib/instructor-eligibility";
import { ConflictError, ForbiddenError, IneligibleError, ValidationError } from "@/lib/app-errors";
import type { AuthUser } from "@/lib/authorization";

// ---------------------------------------------------------------------------
// Publishing an instructor service.
//
// This is the point of action where instructor eligibility is enforced on the
// server: only an approved, active instructor may publish a service. It is the
// reusable pattern for other instructor write paths (availability, accepting
// requests) — all of which must call `evaluateInstructorEligibility`.
// ---------------------------------------------------------------------------

export interface RawServiceInput {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  turnaroundHours?: unknown;
}

export interface NormalizedService {
  code: string;
  name: string;
  description: string | null;
  amountMinor: number;
  currency: string;
  turnaroundHours: number;
}

export type ServiceValidationResult =
  | { ok: true; value: NormalizedService }
  | { ok: false; fields: Record<string, string> };

const LIMITS = {
  nameMin: 2,
  nameMax: 120,
  descMax: 1000,
  amountMax: 50_000_000,
  turnaroundMax: 2000,
};

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return code.length > 0 ? code : null;
}

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

export function validateServiceInput(raw: RawServiceInput): ServiceValidationResult {
  const fields: Record<string, string> = {};

  const code = normalizeCode(raw.code);
  if (!code || !/^[A-Z0-9_]{2,40}$/.test(code)) {
    fields.code = "Provide a service code (2–40 letters, digits or underscores).";
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
    fields.name = `Provide a service name (${LIMITS.nameMin}–${LIMITS.nameMax} characters).`;
  }

  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null && raw.description !== "") {
    if (typeof raw.description !== "string" || raw.description.trim().length > LIMITS.descMax) {
      fields.description = `Description must be ${LIMITS.descMax} characters or fewer.`;
    } else {
      description = raw.description.trim() || null;
    }
  }

  const amountMinor = toInt(raw.amountMinor);
  if (amountMinor === null || amountMinor < 0 || amountMinor > LIMITS.amountMax) {
    fields.amountMinor = "Provide a valid price in minor units (e.g. paise).";
  }

  let currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "INR";
  if (!/^[A-Z]{3}$/.test(currency)) {
    fields.currency = "Currency must be a 3-letter ISO-4217 code.";
    currency = "INR";
  }

  const turnaroundHours = toInt(raw.turnaroundHours);
  if (turnaroundHours === null || turnaroundHours < 1 || turnaroundHours > LIMITS.turnaroundMax) {
    fields.turnaroundHours = `Provide a turnaround between 1 and ${LIMITS.turnaroundMax} hours.`;
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      code: code as string,
      name,
      description,
      amountMinor: amountMinor as number,
      currency,
      turnaroundHours: turnaroundHours as number,
    },
  };
}

export async function publishInstructorService(args: {
  actor: AuthUser;
  input: RawServiceInput;
  request?: Request;
}) {
  const { actor, input, request } = args;

  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    include: { instructorProfile: true },
  });
  if (!user) throw new ForbiddenError("Account not found.");

  const eligibility = evaluateInstructorEligibility({
    role: user.role as Role,
    suspended: user.suspended,
    profile: user.instructorProfile
      ? { isApproved: user.instructorProfile.isApproved, isActive: user.instructorProfile.isActive }
      : null,
  });

  if (!eligibility.eligible || !user.instructorProfile) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_SERVICE_PUBLISH_DENIED,
      metadata: { reasons: eligibility.reasons },
      request,
    });
    throw new IneligibleError(
      "Your instructor account is not eligible to publish services.",
      eligibility.reasons,
    );
  }

  const result = validateServiceInput(input);
  if (!result.ok) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_SERVICE_PUBLISH_DENIED,
      metadata: { reason: "validation", fields: Object.keys(result.fields) },
      request,
    });
    throw new ValidationError("Please correct the highlighted fields.", result.fields);
  }

  try {
    const service = await prisma.instructorService.create({
      data: {
        instructorId: user.instructorProfile.id,
        code: result.value.code,
        name: result.value.name,
        description: result.value.description,
        amountMinor: result.value.amountMinor,
        currency: result.value.currency,
        turnaroundHours: result.value.turnaroundHours,
      },
    });

    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_SERVICE_PUBLISHED,
      targetType: "InstructorService",
      targetId: service.id,
      metadata: { code: service.code, instructorProfileId: user.instructorProfile.id },
      request,
    });

    return service;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictError("A service with this code already exists.");
    }
    throw error;
  }
}

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { checkPasswordPolicy, hashPassword, normalizeEmail } from "@/lib/password";
import {
  AUDIT_ACTIONS,
  canReapply,
  canTransitionApplicationStatus,
  isApplicationStatus,
  type ApplicationStatus,
} from "@/lib/domain";
import {
  canReviewApplications,
  canSubmitInstructorApplication,
  canViewApplication,
  canWithdrawApplication,
  type AuthUser,
} from "@/lib/authorization";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/app-errors";

// ---------------------------------------------------------------------------
// Instructor application workflow.
//
// Authorization is enforced here (in addition to route-level requireRole) using
// pure predicates, so these operations are safe to call directly and can be
// unit-tested without a Next.js runtime. Applicant identity always comes from
// the authenticated `actor`, never from client input.
// ---------------------------------------------------------------------------

export interface RawApplicationInput {
  fullName?: unknown;
  email?: unknown;
  phone?: unknown;
  bio?: unknown;
  expertise?: unknown;
  qualifications?: unknown;
  proposedServices?: unknown;
  termsAccepted?: unknown;
}

export interface RegisterInstructorInput extends RawApplicationInput {
  /** Account password chosen during instructor onboarding; never stored on the application. */
  password?: unknown;
}

export interface ProposedService {
  name: string;
  description: string | null;
  amountMinor: number;
  turnaroundHours: number;
}

export interface NormalizedApplication {
  fullName: string;
  email: string;
  phone: string | null;
  bio: string;
  expertise: string[];
  qualifications: string[];
  proposedServices: ProposedService[];
}

export type ValidationResult =
  | { ok: true; value: NormalizedApplication }
  | { ok: false; fields: Record<string, string> };

const LIMITS = {
  fullNameMin: 2,
  fullNameMax: 120,
  bioMin: 40,
  bioMax: 5000,
  phoneMax: 32,
  listItemMax: 100,
  listMax: 30,
  listMin: 1,
  nameMax: 120,
  descMax: 600,
  amountMax: 50_000_000,
  turnaroundMax: 2000,
};

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t : null;
}

function longText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/** Accepts an array of strings or a comma/newline-separated string. */
export function toStringList(value: unknown): string[] {
  let parts: string[] = [];
  if (Array.isArray(value)) {
    parts = value.filter((v): v is string => typeof v === "string");
  } else if (typeof value === "string") {
    parts = value.split(/[,\n]/);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const t = part.trim().replace(/\s+/g, " ");
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

export function validateInstructorApplicationInput(raw: RawApplicationInput): ValidationResult {
  const fields: Record<string, string> = {};

  const fullName = trimmed(raw.fullName);
  if (!fullName || fullName.length < LIMITS.fullNameMin || fullName.length > LIMITS.fullNameMax) {
    fields.fullName = `Enter your full name (${LIMITS.fullNameMin}–${LIMITS.fullNameMax} characters).`;
  }

  const email = normalizeEmail(typeof raw.email === "string" ? raw.email : "");
  if (!email.valid || !email.normalized) {
    fields.email = "Enter a valid email address.";
  }

  let phone: string | null = null;
  if (raw.phone !== undefined && raw.phone !== null && raw.phone !== "") {
    const candidate = trimmed(raw.phone);
    if (!candidate || candidate.length > LIMITS.phoneMax || !/^[+()\-.\s\d]+$/.test(candidate)) {
      fields.phone = `Enter a valid phone number (max ${LIMITS.phoneMax} characters).`;
    } else {
      phone = candidate;
    }
  }

  const bio = longText(raw.bio);
  if (!bio || bio.length < LIMITS.bioMin || bio.length > LIMITS.bioMax) {
    fields.bio = `Describe your background and experience (${LIMITS.bioMin}–${LIMITS.bioMax} characters).`;
  }

  const expertise = toStringList(raw.expertise);
  if (expertise.length < LIMITS.listMin || expertise.length > LIMITS.listMax) {
    fields.expertise = `List between ${LIMITS.listMin} and ${LIMITS.listMax} areas of expertise.`;
  } else if (expertise.some((item) => item.length > LIMITS.listItemMax)) {
    fields.expertise = `Each expertise entry must be ${LIMITS.listItemMax} characters or fewer.`;
  }

  const qualifications = toStringList(raw.qualifications);
  if (qualifications.length < LIMITS.listMin || qualifications.length > LIMITS.listMax) {
    fields.qualifications = `List between ${LIMITS.listMin} and ${LIMITS.listMax} qualifications.`;
  } else if (qualifications.some((item) => item.length > LIMITS.listItemMax)) {
    fields.qualifications = `Each qualification must be ${LIMITS.listItemMax} characters or fewer.`;
  }

  const proposedServices: ProposedService[] = [];
  if (raw.proposedServices !== undefined && raw.proposedServices !== null && raw.proposedServices !== "") {
    if (!Array.isArray(raw.proposedServices)) {
      fields.proposedServices = "Proposed services must be a list.";
    } else {
      raw.proposedServices.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
          fields.proposedServices = `Service #${index + 1} is invalid.`;
          return;
        }
        const record = entry as Record<string, unknown>;
        const name = trimmed(record.name);
        const description = longText(record.description);
        const amountMinor = toInt(record.amountMinor);
        const turnaroundHours = toInt(record.turnaroundHours);

        if (!name || name.length > LIMITS.nameMax) {
          fields.proposedServices = `Service #${index + 1} needs a name (max ${LIMITS.nameMax} characters).`;
        }
        if (description && description.length > LIMITS.descMax) {
          fields.proposedServices = `Service #${index + 1} description is too long (max ${LIMITS.descMax}).`;
        }
        if (amountMinor === null || amountMinor < 0 || amountMinor > LIMITS.amountMax) {
          fields.proposedServices = `Service #${index + 1} needs a valid price in minor units.`;
        }
        if (turnaroundHours === null || turnaroundHours < 1 || turnaroundHours > LIMITS.turnaroundMax) {
          fields.proposedServices = `Service #${index + 1} needs a valid turnaround (hours).`;
        }

        if (name && amountMinor !== null && turnaroundHours !== null) {
          proposedServices.push({
            name,
            description: description ?? null,
            amountMinor,
            turnaroundHours,
          });
        }
      });
    }
  }

  if (raw.termsAccepted !== true) {
    fields.termsAccepted = "You must accept the terms to submit an application.";
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      fullName: fullName as string,
      email: email.normalized as string,
      phone,
      bio: bio as string,
      expertise,
      qualifications,
      proposedServices,
    },
  };
}

function serializeList(list: string[]): string | null {
  return list.length > 0 ? JSON.stringify(list) : null;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseProposedServices(value: string | null): ProposedService[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ProposedService[]) : [];
  } catch {
    return [];
  }
}

/** A client-safe representation with JSON columns decoded. */
export interface PublicApplication {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  bio: string;
  expertise: string[];
  qualifications: string[];
  proposedServices: ProposedService[];
  status: ApplicationStatus;
  reviewedAt: string | null;
  reviewedById: string | null;
  rejectionReason: string | null;
  reviewNotes: string | null;
  instructorProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

type ApplicationRow = {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  bio: string;
  expertise: string | null;
  qualifications: string | null;
  proposedServices: string | null;
  status: string;
  reviewedAt: Date | null;
  reviewedById: string | null;
  rejectionReason: string | null;
  reviewNotes: string | null;
  instructorProfileId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toPublicApplication(row: ApplicationRow): PublicApplication {
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    bio: row.bio,
    expertise: parseList(row.expertise),
    qualifications: parseList(row.qualifications),
    proposedServices: parseProposedServices(row.proposedServices),
    status: (isApplicationStatus(row.status) ? row.status : "PENDING") as ApplicationStatus,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedById: row.reviewedById,
    rejectionReason: row.rejectionReason,
    reviewNotes: row.reviewNotes,
    instructorProfileId: row.instructorProfileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// --- applicant operations ----------------------------------------------------

export async function submitInstructorApplication(args: {
  actor: AuthUser;
  input: RawApplicationInput;
  request?: Request;
}): Promise<PublicApplication> {
  const { actor, input, request } = args;

  if (!canSubmitInstructorApplication(actor)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMIT_DENIED,
      metadata: { reason: "role_not_permitted", role: actor.role },
      request,
    });
    throw new ForbiddenError("Only student accounts may submit an instructor application.");
  }

  const result = validateInstructorApplicationInput(input);
  if (!result.ok) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMIT_DENIED,
      metadata: { reason: "validation", fields: Object.keys(result.fields) },
      request,
    });
    throw new ValidationError("Please correct the highlighted fields.", result.fields);
  }

  const value = result.value;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.instructorApplication.findMany({
        where: { userId: actor.id },
        select: { status: true },
      });
      const hasPending = existing.some((a) => a.status === "PENDING");
      const hasApproved = existing.some((a) => a.status === "APPROVED");

      if (!canReapply(hasPending, hasApproved)) {
        throw new ConflictError(
          hasApproved
            ? "You are already an approved instructor."
            : "You already have an application under review.",
        );
      }

      return tx.instructorApplication.create({
        data: {
          userId: actor.id,
          fullName: value.fullName,
          email: value.email,
          phone: value.phone,
          bio: value.bio,
          expertise: serializeList(value.expertise),
          qualifications: serializeList(value.qualifications),
          proposedServices:
            value.proposedServices.length > 0 ? JSON.stringify(value.proposedServices) : null,
          termsAcceptedAt: new Date(),
          status: "PENDING",
          // Duplicate guard: at most one open application per user.
          activeKey: actor.id,
        },
      });
    });

    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMITTED,
      targetType: "InstructorApplication",
      targetId: created.id,
      metadata: { expertiseCount: value.expertise.length, serviceCount: value.proposedServices.length },
      request,
    });

    return toPublicApplication(created);
  } catch (error) {
    if (error instanceof ConflictError) {
      await recordAuditEvent({
        actorId: actor.id,
        action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMIT_DENIED,
        metadata: { reason: "duplicate_or_already_approved" },
        request,
      });
      throw error;
    }
    if (isUniqueViolation(error)) {
      await recordAuditEvent({
        actorId: actor.id,
        action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMIT_DENIED,
        metadata: { reason: "duplicate_pending" },
        request,
      });
      throw new ConflictError("You already have an application under review.");
    }
    throw error;
  }
}

/** The caller's most recent application, or null. */
export async function getMyInstructorApplication(args: {
  actor: AuthUser;
}): Promise<PublicApplication | null> {
  const row = await prisma.instructorApplication.findFirst({
    where: { userId: args.actor.id },
    orderBy: { createdAt: "desc" },
  });
  return row ? toPublicApplication(row) : null;
}

/** True when the user has ever submitted an instructor application. */
export async function hasInstructorApplication(userId: string): Promise<boolean> {
  const count = await prisma.instructorApplication.count({ where: { userId } });
  return count > 0;
}

/**
 * Instructor-path onboarding: create the unified account and a PENDING
 * application in one transaction. The account remains a STUDENT until an
 * administrator approves the application, so no instructor capability is
 * granted here. The role is fixed server-side and never read from the body.
 *
 * The dedicated public endpoint exists so a prospective instructor never has
 * to go through student registration first; the approval workflow itself is
 * unchanged.
 */
export async function registerInstructorApplicant(args: {
  input: RegisterInstructorInput;
  request?: Request;
}): Promise<{ application: PublicApplication; userId: string }> {
  const { input, request } = args;

  const result = validateInstructorApplicationInput(input);
  if (!result.ok) {
    throw new ValidationError("Please correct the highlighted fields.", result.fields);
  }

  const password = typeof input.password === "string" ? input.password : "";
  const policy = checkPasswordPolicy(password);
  if (!policy.valid) {
    throw new ValidationError(policy.error ?? "Password does not meet requirements.", {
      password: policy.error ?? "Password does not meet requirements.",
    });
  }

  const value = result.value;
  const passwordHash = await hashPassword(password);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: value.fullName,
          email: value.email,
          passwordHash,
          role: "STUDENT",
        },
      });
      await tx.studentProfile.create({ data: { userId: user.id } });

      const application = await tx.instructorApplication.create({
        data: {
          userId: user.id,
          fullName: value.fullName,
          email: value.email,
          phone: value.phone,
          bio: value.bio,
          expertise: serializeList(value.expertise),
          qualifications: serializeList(value.qualifications),
          proposedServices:
            value.proposedServices.length > 0 ? JSON.stringify(value.proposedServices) : null,
          termsAcceptedAt: new Date(),
          status: "PENDING",
          // Duplicate guard: at most one open application per user.
          activeKey: user.id,
        },
      });

      return { user, application };
    });

    await recordAuditEvent({
      actorId: created.user.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMITTED,
      targetType: "InstructorApplication",
      targetId: created.application.id,
      metadata: {
        source: "instructor_registration",
        expertiseCount: value.expertise.length,
        serviceCount: value.proposedServices.length,
      },
      request,
    });

    return { application: toPublicApplication(created.application), userId: created.user.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("An account with this email already exists.");
    }
    throw error;
  }
}

export async function withdrawInstructorApplication(args: {
  actor: AuthUser;
  applicationId: string;
  request?: Request;
}): Promise<PublicApplication> {
  const { actor, applicationId, request } = args;

  const existing = await prisma.instructorApplication.findUnique({ where: { id: applicationId } });
  if (!existing) throw new NotFoundError("Application not found.");

  if (!canWithdrawApplication(actor, existing)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_SUBMIT_DENIED,
      targetType: "InstructorApplication",
      targetId: applicationId,
      metadata: { reason: "not_owner" },
      request,
    });
    throw new ForbiddenError("You may only withdraw your own application.");
  }

  // Atomic transition: only a PENDING row can move to WITHDRAWN.
  const result = await prisma.instructorApplication.updateMany({
    where: { id: applicationId, status: "PENDING" },
    data: { status: "WITHDRAWN", activeKey: null, reviewedAt: new Date() },
  });
  if (result.count === 0) {
    throw new ConflictError("Only an application under review can be withdrawn.");
  }

  await recordAuditEvent({
    actorId: actor.id,
    action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_WITHDRAWN,
    targetType: "InstructorApplication",
    targetId: applicationId,
    request,
  });

  const updated = await prisma.instructorApplication.findUnique({ where: { id: applicationId } });
  return toPublicApplication(updated as ApplicationRow);
}

// --- administrator operations ------------------------------------------------

export interface ListInput {
  actor: AuthUser;
  status?: unknown;
  page?: unknown;
  pageSize?: unknown;
  request?: Request;
}

export interface ApplicationList {
  items: PublicApplication[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = toInt(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function listInstructorApplications(input: ListInput): Promise<ApplicationList> {
  const { actor, request } = input;

  if (!canReviewApplications(actor)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_REVIEW_DENIED,
      metadata: { reason: "not_admin", operation: "list" },
      request,
    });
    throw new ForbiddenError("Only administrators may review applications.");
  }

  let statusFilter: ApplicationStatus | undefined;
  if (input.status !== undefined && input.status !== null && input.status !== "") {
    if (!isApplicationStatus(input.status)) {
      throw new ValidationError("Unknown application status filter.", {
        status: "Unknown application status.",
      });
    }
    statusFilter = input.status;
  }

  const page = clampInt(input.page, 1, 1, 100_000);
  const pageSize = clampInt(input.pageSize, 20, 1, 100);
  const where = statusFilter ? { status: statusFilter } : {};

  const [total, rows] = await prisma.$transaction([
    prisma.instructorApplication.count({ where }),
    prisma.instructorApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    items: rows.map(toPublicApplication),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface AdminOverviewStats {
  applications: {
    pending: number;
    approved: number;
    rejected: number;
    withdrawn: number;
    total: number;
  };
  accounts: {
    students: number;
    instructors: number;
    admins: number;
  };
}

/**
 * Real, database-backed counts for the admin dashboard. Only administrators may
 * call this; denial is audited like every other review operation.
 */
export async function getAdminOverviewStats(args: {
  actor: AuthUser;
  request?: Request;
}): Promise<AdminOverviewStats> {
  const { actor, request } = args;

  if (!canReviewApplications(actor)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_REVIEW_DENIED,
      metadata: { reason: "not_admin", operation: "overview" },
      request,
    });
    throw new ForbiddenError("Only administrators may view the admin overview.");
  }

  const [pending, approved, rejected, withdrawn, students, instructors, admins] =
    await prisma.$transaction([
      prisma.instructorApplication.count({ where: { status: "PENDING" } }),
      prisma.instructorApplication.count({ where: { status: "APPROVED" } }),
      prisma.instructorApplication.count({ where: { status: "REJECTED" } }),
      prisma.instructorApplication.count({ where: { status: "WITHDRAWN" } }),
      prisma.user.count({ where: { role: "STUDENT" } }),
      prisma.user.count({ where: { role: "INSTRUCTOR" } }),
      prisma.user.count({ where: { role: "ADMIN" } }),
    ]);

  return {
    applications: {
      pending,
      approved,
      rejected,
      withdrawn,
      total: pending + approved + rejected + withdrawn,
    },
    accounts: {
      students,
      instructors,
      admins,
    },
  };
}

export async function getInstructorApplication(args: {
  actor: AuthUser;
  applicationId: string;
  request?: Request;
}): Promise<PublicApplication> {
  const { actor, applicationId, request } = args;

  const row = await prisma.instructorApplication.findUnique({ where: { id: applicationId } });
  if (!row) throw new NotFoundError("Application not found.");

  if (!canViewApplication(actor, row)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_REVIEW_DENIED,
      targetType: "InstructorApplication",
      targetId: applicationId,
      metadata: { reason: "not_permitted", operation: "view" },
      request,
    });
    throw new ForbiddenError("You do not have permission to view this application.");
  }

  return toPublicApplication(row);
}

export type ReviewDecision = "APPROVE" | "REJECT";

export async function decideInstructorApplication(args: {
  actor: AuthUser;
  applicationId: string;
  decision: ReviewDecision;
  rejectionReason?: unknown;
  reviewNotes?: unknown;
  request?: Request;
}): Promise<PublicApplication> {
  const { actor, applicationId, decision, request } = args;

  if (!canReviewApplications(actor)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_REVIEW_DENIED,
      targetType: "InstructorApplication",
      targetId: applicationId,
      metadata: { reason: "not_admin", operation: "decide" },
      request,
    });
    throw new ForbiddenError("Only administrators may decide applications.");
  }

  if (decision !== "APPROVE" && decision !== "REJECT") {
    throw new ValidationError("Invalid decision.", { decision: "Decision must be approve or reject." });
  }

  let rejectionReason: string | null = null;
  if (decision === "REJECT") {
    rejectionReason = typeof args.rejectionReason === "string" ? args.rejectionReason.trim() : "";
    if (rejectionReason.length < 10 || rejectionReason.length > 2000) {
      throw new ValidationError("A rejection reason is required.", {
        rejectionReason: "Provide a rejection reason (10–2000 characters).",
      });
    }
  }

  const notes =
    typeof args.reviewNotes === "string" && args.reviewNotes.trim().length > 0
      ? args.reviewNotes.trim().slice(0, 2000)
      : null;

  try {
    const target = await prisma.instructorApplication.findUnique({
      where: { id: applicationId },
      include: { user: { select: { id: true, suspended: true } } },
    });
    if (!target) throw new NotFoundError("Application not found.");

    // An applicant can never decide their own application, even if they have
    // been granted administrator privileges in the meantime.
    if (target.userId === actor.id) {
      await recordAuditEvent({
        actorId: actor.id,
        action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_REVIEW_DENIED,
        targetType: "InstructorApplication",
        targetId: applicationId,
        metadata: { reason: "self_review", operation: "decide" },
        request,
      });
      throw new ForbiddenError("You cannot decide your own application.");
    }

    const nextStatus: ApplicationStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (!canTransitionApplicationStatus("PENDING", nextStatus)) {
      throw new ConflictError("This application cannot be transitioned.");
    }
    if (target.status !== "PENDING") {
      throw new ConflictError("This application has already been decided.");
    }
    if (decision === "APPROVE" && target.user.suspended) {
      throw new ConflictError("Cannot approve an application for a suspended account.");
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Compare-and-set: only a currently-PENDING row is updated. This makes
      // simultaneous decisions safe — exactly one caller wins.
      const cas = await tx.instructorApplication.updateMany({
        where: { id: applicationId, status: "PENDING" },
        data: {
          status: nextStatus,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          rejectionReason: decision === "REJECT" ? rejectionReason : null,
          reviewNotes: notes,
          activeKey: null,
        },
      });
      if (cas.count === 0) {
        throw new ConflictError("This application was already decided.");
      }

      if (decision === "APPROVE") {
        const profile = await tx.instructorProfile.upsert({
          where: { userId: target.userId },
          create: {
            userId: target.userId,
            bio: target.bio,
            expertise: target.expertise,
            qualifications: target.qualifications,
            isApproved: true,
            isActive: true,
            approvedAt: new Date(),
            approvedById: actor.id,
          },
          update: {
            isApproved: true,
            isActive: true,
            approvedAt: new Date(),
            approvedById: actor.id,
          },
        });
        await tx.user.update({ where: { id: target.userId }, data: { role: "INSTRUCTOR" } });
        await tx.instructorApplication.update({
          where: { id: applicationId },
          data: { instructorProfileId: profile.id },
        });
      }

      return tx.instructorApplication.findUniqueOrThrow({ where: { id: applicationId } });
    });

    await recordAuditEvent({
      actorId: actor.id,
      action:
        decision === "APPROVE"
          ? AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_APPROVED
          : AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_REJECTED,
      targetType: "InstructorApplication",
      targetId: applicationId,
      metadata: { applicantId: target.userId, decision },
      request,
    });

    return toPublicApplication(updated);
  } catch (error) {
    if (error instanceof ConflictError) {
      await recordAuditEvent({
        actorId: actor.id,
        action: AUDIT_ACTIONS.INSTRUCTOR_APPLICATION_DECISION_CONFLICT,
        targetType: "InstructorApplication",
        targetId: applicationId,
        metadata: { decision },
        request,
      });
    }
    throw error;
  }
}

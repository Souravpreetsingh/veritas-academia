// Instructor eligibility — the single server-side rule that governs whether an
// instructor may publish services, appear in the public catalogue, or accept
// paid requests.
//
// A user is an eligible instructor only when ALL of the following hold:
//   - their role is INSTRUCTOR,
//   - their account is not suspended,
//   - they have an InstructorProfile that is both approved AND active.
//
// Pure and dependency-free so every write path can share it and it can be
// unit-tested directly.

import type { Role } from "@/lib/domain";

export interface InstructorProfileState {
  isApproved: boolean;
  isActive: boolean;
}

export interface EligibilityInput {
  role: Role;
  suspended: boolean;
  profile: InstructorProfileState | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export function evaluateInstructorEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];

  if (input.role !== "INSTRUCTOR") {
    reasons.push("Account does not hold the instructor role.");
  }
  if (input.suspended) {
    reasons.push("Account is suspended.");
  }
  if (!input.profile) {
    reasons.push("No instructor profile exists.");
  } else {
    if (!input.profile.isApproved) {
      reasons.push("Instructor application has not been approved.");
    }
    if (!input.profile.isActive) {
      reasons.push("Instructor profile is inactive.");
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

export function isEligibleInstructor(input: EligibilityInput): boolean {
  return evaluateInstructorEligibility(input).eligible;
}

// The three actions below share the same eligibility rule; they are named
// separately for readable call sites and future divergence.
export function canPublishService(input: EligibilityInput): boolean {
  return isEligibleInstructor(input);
}

export function canAppearInCatalog(input: EligibilityInput): boolean {
  return isEligibleInstructor(input);
}

export function canAcceptRequests(input: EligibilityInput): boolean {
  return isEligibleInstructor(input);
}

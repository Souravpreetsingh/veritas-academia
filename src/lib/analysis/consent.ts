// Student consent for external LLM processing.
//
// Consent is deliberately explicit and revocable. It is required in addition to
// server configuration before document text may be sent to an external model.
// The version string records which privacy notice the student accepted.

import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/domain";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/app-errors";
import type { AuthUser } from "@/lib/authorization";
import { LLM_CONSENT_VERSION } from "./types";

export { LLM_CONSENT_VERSION };

export interface LlmConsentState {
  granted: boolean;
  grantedAt: Date | null;
  version: string | null;
}

export function hasLlmConsent(request: {
  llmProcessingConsentAt: Date | null;
  llmProcessingConsentVersion: string | null;
}): boolean {
  return (
    request.llmProcessingConsentAt !== null &&
    request.llmProcessingConsentVersion === LLM_CONSENT_VERSION
  );
}

export function canGrantLlmConsent(status: string): boolean {
  return status === "PAID" || status === "ACCEPTED";
}

function cleanRequestId(value: unknown): string {
  if (typeof value !== "string") throw new NotFoundError("Request not found.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) throw new NotFoundError("Request not found.");
  return trimmed;
}

/**
 * Record or withdraw the owning student's consent. The client supplies only a
 * boolean; the request, owner, version, and timestamps are resolved server-side.
 */
export async function setLlmProcessingConsent(args: {
  actor: AuthUser;
  requestId: unknown;
  consent: unknown;
  request?: Request;
}): Promise<LlmConsentState> {
  const requestId = cleanRequestId(args.requestId);
  if (args.actor.role !== "STUDENT") {
    throw new NotFoundError("Request not found.");
  }
  if (typeof args.consent !== "boolean") {
    throw new ValidationError("Choose whether to allow external LLM processing.", {
      consent: "Consent must be true or false.",
    });
  }

  const existing = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      studentId: true,
      status: true,
      llmProcessingConsentAt: true,
      llmProcessingConsentVersion: true,
    },
  });
  // Never confirm another student's request exists.
  if (!existing || existing.studentId !== args.actor.id) {
    throw new NotFoundError("Request not found.");
  }

  if (args.consent && !canGrantLlmConsent(existing.status)) {
    throw new ConflictError(
      "Consent for external LLM processing can be recorded after payment is verified and before the request is declined.",
    );
  }

  const now = new Date();
  const updated = await prisma.serviceRequest.update({
    where: { id: existing.id },
    data: args.consent
      ? { llmProcessingConsentAt: now, llmProcessingConsentVersion: LLM_CONSENT_VERSION }
      : { llmProcessingConsentAt: null, llmProcessingConsentVersion: null },
    select: {
      llmProcessingConsentAt: true,
      llmProcessingConsentVersion: true,
    },
  });

  await recordAuditEvent({
    actorId: args.actor.id,
    action: args.consent
      ? AUDIT_ACTIONS.ANALYSIS_LLM_CONSENT_GRANTED
      : AUDIT_ACTIONS.ANALYSIS_LLM_CONSENT_WITHDRAWN,
    targetType: "ServiceRequest",
    targetId: existing.id,
    metadata: {
      version: args.consent ? LLM_CONSENT_VERSION : null,
      // Record whether any consent row existed, even if its notice version is
      // now stale, so grant/withdraw history stays auditable.
      hadConsent: existing.llmProcessingConsentAt !== null,
    },
    request: args.request,
  });

  return {
    granted: updated.llmProcessingConsentAt !== null,
    grantedAt: updated.llmProcessingConsentAt,
    version: updated.llmProcessingConsentVersion,
  };
}

import { prisma } from "@/lib/db";
import { resolveClientIp } from "@/lib/request-ip";

// Best-effort security audit logging. Never records document contents,
// passwords, tokens, or secrets. Failures are swallowed so auditing can never
// break the primary request flow.
//
// Note: this module is intentionally not wrapped in `server-only` so it can be
// imported by domain services (and exercised in the Node test suite). It still
// depends on Prisma/DATABASE_URL and can never run in a browser bundle.
//
// The recorded IP address is advisory metadata from proxy headers and is only
// populated when TRUST_PROXY_HEADERS=true (see src/lib/request-ip.ts).

export interface AuditInput {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Non-sensitive structured context only. */
  metadata?: Record<string, unknown>;
  request?: Request;
}

export async function recordAuditEvent(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        ipAddress: resolveClientIp(input.request),
        userAgent: input.request?.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
    });
  } catch (error) {
    // Audit logging must never break the main flow.
    console.error("[audit] failed to record event:", input.action, error);
  }
}

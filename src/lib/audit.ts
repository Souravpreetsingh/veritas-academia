import "server-only";
import { prisma } from "@/lib/db";

// Best-effort security audit logging. Never records document contents,
// passwords, tokens, or secrets. Failures are swallowed so auditing can never
// break the primary request flow.

export interface AuditInput {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Non-sensitive structured context only. */
  metadata?: Record<string, unknown>;
  request?: Request;
}

function clientIp(request?: Request): string | null {
  if (!request) return null;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 100);
  return request.headers.get("x-real-ip")?.slice(0, 100) ?? null;
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
        ipAddress: clientIp(input.request),
        userAgent: input.request?.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
    });
  } catch (error) {
    // Audit logging must never break the main flow.
    console.error("[audit] failed to record event:", input.action, error);
  }
}

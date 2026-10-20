import { NextResponse } from "next/server";
import { errorResponse, jsonError } from "@/lib/api";
import { processRazorpayWebhook } from "@/lib/payments";
import { REQUEST_BODY_LIMITS, readBodyTextWithLimit } from "@/lib/request-body";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/domain";

export const runtime = "nodejs";

// Razorpay webhook endpoint.
//
// There is no session here: authenticity comes exclusively from the webhook
// signature, verified against the exact raw request body before parsing (see
// src/lib/razorpay.ts). Processing is idempotent — duplicate deliveries are
// detected by the unique event id and acknowledged without re-applying.
//
// The raw body is read through a hard byte budget so an unauthenticated client
// cannot exhaust memory before the signature check runs.
//
// Response contract for Razorpay retries:
//   400/413 — invalid or malformed delivery (do not retry meaningfully),
//   200     — applied / duplicate / ignored (retry never helps),
//   503     — server not configured,
//   500     — unexpected failure (Razorpay retries transient failures).
//
// Local and production webhook configuration is documented in docs/payments.md.
export async function POST(request: Request) {
  const signature = request.headers.get("x-razorpay-signature");
  const eventId = request.headers.get("x-razorpay-event-id");

  const body = await readBodyTextWithLimit(request.body, REQUEST_BODY_LIMITS.webhookBytes);
  if (!body.ok) {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      metadata: {
        reason: body.reason === "too_large" ? "body_too_large" : "body_unreadable",
      },
      request,
    });
    return jsonError(
      body.reason === "too_large" ? "Webhook body is too large." : "Could not read the webhook body.",
      body.reason === "too_large" ? 413 : 400,
    );
  }

  try {
    const result = await processRazorpayWebhook({
      rawBody: body.text,
      signature,
      eventId,
      request,
    });
    return NextResponse.json(
      { received: true, outcome: result.outcome },
      { status: result.httpStatus, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error(
      "[payments] webhook processing failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonError("Webhook processing failed.", 500);
  }
}

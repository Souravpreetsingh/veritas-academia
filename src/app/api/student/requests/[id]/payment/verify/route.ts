import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { verifyCheckoutPayment } from "@/lib/payments";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";
import { guardPaymentVerify } from "@/lib/rate-limit-guard";

export const runtime = "nodejs";

// Verify a Razorpay Checkout result. Only the three documented checkout fields
// are read from the body; ownership, the local payment record, the signature
// and the captured provider payment are all re-checked server-side. The
// callback alone never marks anything paid.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let user;
  try {
    user = await requireRole(["STUDENT"]);
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }

  // Bound repeated verification attempts per student: each call may reach the
  // payment provider. Repeated verification of the same result stays
  // idempotent; the limiter only caps abusive repetition.
  const limited = await guardPaymentVerify(user.id);
  if (limited) return limited;

  const parsed = await readJsonBodyWithLimit(request.body, REQUEST_BODY_LIMITS.jsonBytes);
  if (!parsed.ok) {
    return jsonError(
      parsed.tooLarge ? "The request body is too large." : "Malformed request body.",
      parsed.tooLarge ? 413 : 400,
    );
  }
  const body = parsed.value;
  const payload =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  try {
    const result = await verifyCheckoutPayment({
      actor: user,
      requestId: id,
      orderId: payload.razorpay_order_id,
      paymentId: payload.razorpay_payment_id,
      signature: payload.razorpay_signature,
      request,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error(
      "[payments] checkout verification failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonError("Payment verification failed.", 500);
  }
}

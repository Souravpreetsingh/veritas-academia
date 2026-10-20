import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { createPaymentOrder } from "@/lib/payments";
import { guardPaymentOrder } from "@/lib/rate-limit-guard";

export const runtime = "nodejs";

// Create (or resume) the Razorpay order for an owned, payable service request.
// The amount and currency always come from the persisted request snapshot; the
// request body is ignored entirely, so client-supplied prices can never be
// trusted. Creating an order does not mark the request paid.
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

  // Bound repeated order-creation attempts per student. Creating an order is
  // idempotent (an active order is resumed), so legitimate retries are not
  // broken; the limiter only caps abusive repetition.
  const limited = await guardPaymentOrder(user.id);
  if (limited) return limited;

  try {
    const result = await createPaymentOrder({ actor: user, requestId: id, request });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error(
      "[payments] order creation failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonError("The payment could not be initiated.", 500);
  }
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Razorpay checkout panel for an owned service request.
//
// The server creates the provider order and returns only public checkout
// details (public key id, order id, stored amount/currency). The browser never
// decides the price and never marks anything paid: after checkout the server
// re-verifies the signature and the captured provider payment before the
// persisted status changes, and this panel simply refreshes the page.

interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface CheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  handler: (response: CheckoutSuccess) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
}

interface CheckoutInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: CheckoutOptions) => CheckoutInstance;
  }
}

interface CreateOrderResponse {
  paymentId?: string;
  orderId?: string;
  keyId?: string;
  amountMinor?: number;
  currency?: string;
  requestReference?: string;
  resumed?: boolean;
  error?: string;
}

let checkoutScriptPromise: Promise<boolean> | null = null;

function loadCheckoutScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (!checkoutScriptPromise) {
    checkoutScriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(Boolean(window.Razorpay));
      script.onerror = () => {
        checkoutScriptPromise = null;
        resolve(false);
      };
      document.body.appendChild(script);
    });
  }
  return checkoutScriptPromise;
}

export default function PayNowPanel({
  requestId,
  reference,
  amountLabel,
  checkoutActive,
  lastAttemptFailed,
}: {
  requestId: string;
  reference: string;
  amountLabel: string;
  checkoutActive: boolean;
  lastAttemptFailed: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "initiating" | "verifying">("idle");
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(
    null,
  );

  const busy = phase !== "idle";

  async function verifyPayment(response: CheckoutSuccess) {
    setPhase("verifying");
    setMessage({ tone: "info", text: "Verifying the payment with the server…" });
    try {
      const result = await fetch(
        `/api/student/requests/${encodeURIComponent(requestId)}/payment/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          }),
        },
      );
      const payload = (await result.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
      };
      if (!result.ok) {
        setMessage({
          tone: "error",
          text: payload.error ?? "The payment could not be verified. Contact support if it persists.",
        });
      } else if (payload.status === "PAID") {
        setMessage({ tone: "ok", text: "Payment confirmed. The instructor can now review this request." });
      } else {
        setMessage({
          tone: "info",
          text: "Payment is still being confirmed by the provider. This page updates automatically once it is verified.",
        });
      }
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "The payment could not be verified. Check your connection." });
    } finally {
      setPhase("idle");
    }
  }

  async function startPayment() {
    setPhase("initiating");
    setMessage(null);
    try {
      const result = await fetch(
        `/api/student/requests/${encodeURIComponent(requestId)}/payment`,
        { method: "POST" },
      );
      const payload = (await result.json().catch(() => ({}))) as CreateOrderResponse;
      if (
        !result.ok ||
        !payload.keyId ||
        !payload.orderId ||
        typeof payload.amountMinor !== "number" ||
        !payload.currency
      ) {
        setMessage({
          tone: "error",
          text: payload.error ?? "The payment could not be started. Please try again.",
        });
        return;
      }

      const loaded = await loadCheckoutScript();
      if (!loaded || !window.Razorpay) {
        setMessage({
          tone: "error",
          text: "The secure checkout could not be loaded. Check your connection and try again.",
        });
        return;
      }

      setPhase("idle");
      const checkout = new window.Razorpay({
        key: payload.keyId,
        amount: payload.amountMinor,
        currency: payload.currency,
        name: "Veritas Academia",
        description: `Service request ${payload.requestReference ?? reference}`,
        order_id: payload.orderId,
        theme: { color: "#ff2d78" },
        handler: (response) => {
          void verifyPayment(response);
        },
        modal: {
          ondismiss: () => {
            setMessage({
              tone: "info",
              text: "Checkout closed before payment was completed. Any confirmed payment still appears here automatically.",
            });
            router.refresh();
          },
        },
      });
      checkout.open();
    } catch {
      setMessage({ tone: "error", text: "The payment could not be started. Check your connection." });
    } finally {
      setPhase((current) => (current === "initiating" ? "idle" : current));
    }
  }

  const buttonLabel =
    phase === "initiating"
      ? "Opening checkout…"
      : phase === "verifying"
        ? "Verifying payment…"
        : lastAttemptFailed
          ? "Try payment again"
          : checkoutActive
            ? "Resume payment"
            : "Pay securely";

  return (
    <div className="mt-4 space-y-3">
      <p className="text-[11px] font-body text-on-surface-variant">
        {lastAttemptFailed
          ? "The last payment attempt did not complete — nothing was confirmed. You can try again."
          : checkoutActive
            ? "A checkout was already started for this request. You can resume it securely."
            : `Pay ${amountLabel} securely with Razorpay. Card details are handled by Razorpay and never touch this application.`}
      </p>

      <button
        type="button"
        onClick={() => void startPayment()}
        disabled={busy}
        className="w-full py-3 rounded-lg bg-primary hover:bg-primary-container disabled:opacity-60 disabled:cursor-not-allowed text-on-primary text-xs font-headline font-semibold transition-colors"
      >
        {buttonLabel}
      </button>

      <p className="text-[10px] font-label text-on-surface-variant/80">
        Your request is marked paid only after the server verifies the payment. Payment status is
        confirmed automatically.
      </p>

      <div aria-live="polite">
        {message ? (
          <p
            className={`text-[11px] font-body rounded border px-3 py-2 ${
              message.tone === "ok"
                ? "text-secondary border-secondary/40 bg-secondary/10"
                : message.tone === "error"
                  ? "text-error border-error/40 bg-error-container/20"
                  : "text-on-surface-variant border-outline-variant/40 bg-surface-container-high"
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { ConfigurationError, ProviderError } from "@/lib/app-errors";

// Server-side Razorpay boundary.
//
// Responsibilities are deliberately narrow:
//   * read and validate provider configuration from the environment;
//   * wrap the official Razorpay Node SDK behind a small gateway interface so
//     the domain service (src/lib/payments.ts) is testable with fakes and no
//     test ever performs a network call;
//   * implement the documented signature-verification protocols with
//     timing-safe comparison.
//
// The key secret and webhook secret are read from the server environment only.
// Nothing in this module is ever imported by a client component; the module is
// intentionally not wrapped in `server-only` so the Node test suite can import
// the pure helpers (same convention as src/lib/audit.ts).

// --- Configuration ----------------------------------------------------------

export interface RazorpayConfig {
  /** Public key id (safe to hand to Razorpay Checkout in the browser). */
  keyId: string;
  /** api key secret — never sent to the client, never logged. */
  keySecret: string;
  /** Webhook signing secret; required only by the webhook endpoint. */
  webhookSecret: string | null;
}

function cleanEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Read Razorpay configuration. Returns null when the checkout key pair is
 * missing; missing configuration must produce a safe error, never a simulated
 * payment. `RAZORPAY_KEY_SECRET` is the documented name; the pre-existing
 * `RAZORPAY_SECRET` alias is still accepted so existing local environments keep
 * working (see .env.example).
 */
export function readRazorpayConfig(
  env: Record<string, string | undefined> = process.env,
): RazorpayConfig | null {
  const keyId = cleanEnvValue(env.RAZORPAY_KEY_ID);
  const keySecret =
    cleanEnvValue(env.RAZORPAY_KEY_SECRET) ?? cleanEnvValue(env.RAZORPAY_SECRET);
  if (!keyId || !keySecret) return null;
  return {
    keyId,
    keySecret,
    webhookSecret: cleanEnvValue(env.RAZORPAY_WEBHOOK_SECRET),
  };
}

// --- Gateway (official SDK wrapper) -----------------------------------------

export interface ProviderOrder {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
}

export interface ProviderPayment {
  id: string;
  orderId: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  errorCode: string | null;
}

export interface CreateProviderOrderInput {
  amountMinor: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}

/**
 * The exact provider surface the domain service relies on. Tests inject fakes;
 * production uses the official SDK below.
 */
export interface RazorpayGateway {
  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
}

function toMinorUnits(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

function toProviderError(operation: string, error: unknown): ProviderError {
  // Log a compact, safe summary only: no secrets, no payloads, no credentials.
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`[razorpay] ${operation} failed (${name})`);
  return new ProviderError();
}

/** Thin wrapper over the official `razorpay` Node SDK. */
export function razorpayGateway(config: RazorpayConfig): RazorpayGateway {
  const client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });

  return {
    async createOrder(input) {
      try {
        const order = await client.orders.create({
          amount: input.amountMinor,
          currency: input.currency,
          receipt: input.receipt,
          notes: input.notes,
        });
        return {
          id: order.id,
          amountMinor: toMinorUnits(order.amount),
          currency: String(order.currency),
          status: String(order.status),
        };
      } catch (error) {
        throw toProviderError("create order", error);
      }
    },

    async fetchPayment(paymentId) {
      try {
        const payment = await client.payments.fetch(paymentId);
        return {
          id: payment.id,
          orderId: payment.order_id ?? null,
          status: String(payment.status),
          amountMinor: toMinorUnits(payment.amount),
          currency: String(payment.currency),
          errorCode: payment.error_code ? String(payment.error_code) : null,
        };
      } catch (error) {
        throw toProviderError("fetch payment", error);
      }
    },
  };
}

// --- Runtime context ---------------------------------------------------------

export interface PaymentContext {
  config: RazorpayConfig;
  gateway: RazorpayGateway;
}

/**
 * Build the production context. Throws a safe 503 error when the key pair is
 * not configured — callers must never fall back to a simulated payment.
 */
export function paymentContext(): PaymentContext {
  const config = readRazorpayConfig();
  if (!config) {
    throw new ConfigurationError(
      "Online payments are not configured on this server. Please try again later or contact support.",
    );
  }
  return { config, gateway: razorpayGateway(config) };
}

// --- Signature verification (documented Razorpay protocols) ------------------

const SIGNATURE_MAX_LENGTH = 512;

function secureEqual(expectedHex: string, candidate: string): boolean {
  const expected = Buffer.from(expectedHex, "utf8");
  const given = Buffer.from(candidate, "utf8");
  // `timingSafeEqual` requires equal lengths. The expected digest length is
  // fixed and public, so the early return leaks nothing.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * Razorpay Checkout protocol: HMAC-SHA256 of "<order_id>|<payment_id>" keyed
 * with the API key secret, hex encoded.
 */
export function verifyCheckoutSignature(
  input: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  const { orderId, paymentId, signature } = input;
  if (!orderId || !paymentId || !signature) return false;
  if (signature.length > SIGNATURE_MAX_LENGTH) return false;
  const expected = createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return secureEqual(expected, signature);
}

/**
 * Razorpay webhook protocol: HMAC-SHA256 of the exact raw request body keyed
 * with the webhook secret. The body must be verified byte-for-byte BEFORE it is
 * parsed; a re-serialized payload will not verify.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): boolean {
  if (!rawBody || !signature) return false;
  if (signature.length > SIGNATURE_MAX_LENGTH) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return secureEqual(expected, signature);
}

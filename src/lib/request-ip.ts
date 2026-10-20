import { readEnv } from "@/lib/env";

// Client-IP extraction for audit metadata.
//
// Proxy headers (X-Forwarded-For, X-Real-IP) are trivially spoofable unless a
// trusted proxy overwrites them. Render does not publish a hard guarantee for
// these headers, so they are ignored unless the operator has verified the
// deployed proxy's behavior and set TRUST_PROXY_HEADERS=true.
//
// This value is advisory metadata: authorization and payment decisions never
// depend on it. Rate limiting may use it only as a coarse per-source bucket
// key, and only while trust is explicitly enabled (src/lib/rate-limit.ts).

/**
 * Resolve a client IP from proxy headers, or null when trust is not enabled.
 *
 * The optional `trustProxyHeaders` argument exists for tests; production call
 * sites rely on the `TRUST_PROXY_HEADERS` environment variable.
 */
export function resolveClientIp(
  request?: Request,
  trustProxyHeaders: boolean = readEnv("TRUST_PROXY_HEADERS") === "true",
): string | null {
  if (!request || !trustProxyHeaders) return null;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 100);
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp ? realIp.slice(0, 100) : null;
}

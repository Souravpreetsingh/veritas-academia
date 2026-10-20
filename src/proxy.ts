import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { buildReportOnlyPolicy, generateNonce } from "@/lib/security/csp";

// Content Security Policy wiring for every HTML page (Phase 4).
//
// Next.js 16 replaced `middleware.ts` with `proxy.ts`. For each page request
// this proxy:
//   1. generates a fresh nonce,
//   2. forwards the nonce (and the full policy) on the REQUEST headers so
//      Next.js tags framework/page/inline scripts with the nonce while
//      server-rendering,
//   3. sends the full report-only policy on the RESPONSE for the browser.
//
// The enforced baseline (`frame-ancestors`, `object-src`, `base-uri`) is set
// in next.config.ts, not here: Next.js folds a response
// `Content-Security-Policy` header back into the render request, so emitting
// the nonce-less enforced header here would overwrite the nonce-bearing
// request policy before Next reads it and no script would be tagged. See the
// note in next.config.ts and docs/security.md.
//
// The policy itself lives in src/lib/security/csp.ts. API routes, static
// assets and prefetches are excluded from the proxy matcher — they are not
// HTML documents, and the report-only policy is document scoped.

export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const development = process.env.NODE_ENV === "development";
  const reportOnlyPolicy = buildReportOnlyPolicy({ nonce, development });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js parses this request header and applies the nonce to its scripts.
  requestHeaders.set("Content-Security-Policy", reportOnlyPolicy);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set("Content-Security-Policy-Report-Only", reportOnlyPolicy);

  return response;
}

export const config = {
  matcher: [
    /*
     * Match every page except:
     * - api (JSON route handlers, including the Razorpay webhook)
     * - _next/static and _next/image (build assets — CSP is document scoped)
     * - favicon.ico
     * Prefetch requests are skipped; the document they prefetch already
     * carries the policy from its own HTML response.
     */
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

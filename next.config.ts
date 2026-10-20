import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Baseline security response headers. The enforced CSP baseline is below;
  // the nonce-bearing full policy is emitted report-only by src/proxy.ts until
  // browser validation (see src/lib/security/csp.ts and docs/security.md).
  // HSTS is deployment specific and belongs in the reverse proxy / platform
  // configuration.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            // Enforced baseline CSP. The full nonce-based policy is emitted
            // report-only by src/proxy.ts; this subset blocks framing, plugins
            // and base-URL changes without affecting scripts, styles, fonts or
            // payments. Keep the value in sync with buildEnforcedPolicy()
            // (tests/csp.test.mjs guards it). It lives here, not in the proxy,
            // because Next.js folds a response Content-Security-Policy header
            // back into the render request; a nonce-less enforced header there
            // would overwrite the nonce-bearing request policy and stop Next
            // from tagging its scripts.
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEnforcedPolicy,
  buildReportOnlyPolicy,
  generateNonce,
} from "@/lib/security/csp";
import { config, proxy } from "@/proxy";

// Guards for the Phase 4 Content Security Policy.
//
// These are static and unit-level checks: they prove the policy is built and
// emitted correctly, that the production policy cannot fall back to
// unsafe-eval, and that exactly one source emits each CSP header. They do NOT
// replace browser-based CSP validation — report-only mode exists precisely
// because that validation has not been performed yet (see docs/security.md).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => existsSync(path.join(root, relative));

const REQUIRED_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
];

function parsePolicy(value) {
  const directives = new Map();
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    directives.set(name.toLowerCase(), rest.join(" "));
  }
  return directives;
}

function nonceOf(policy) {
  const match = policy.match(/'nonce-([^']+)'/);
  assert.ok(match, "policy must carry a nonce");
  return match[1];
}

test("generateNonce issues a fresh 128-bit value for every call", () => {
  const first = generateNonce();
  const second = generateNonce();
  assert.notEqual(first, second);
  const decoded = Buffer.from(first, "base64");
  assert.equal(decoded.length, 16);
  assert.equal(decoded.toString("base64"), first);
});

test("the full policy covers every required directive", () => {
  const policy = parsePolicy(buildReportOnlyPolicy({ nonce: "TEST-NONCE" }));
  for (const directive of REQUIRED_DIRECTIVES) {
    assert.ok(policy.has(directive), `policy is missing ${directive}`);
  }
});

test("the production script policy is nonce-based and forbids unsafe script sources", () => {
  const policy = parsePolicy(buildReportOnlyPolicy({ nonce: "TEST-NONCE" }));
  const scriptSrc = policy.get("script-src");

  assert.match(scriptSrc, /'nonce-TEST-NONCE'/);
  assert.match(scriptSrc, /'strict-dynamic'/);
  assert.match(scriptSrc, /https:\/\/\*\.razorpay\.com/);
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "production must not allow eval");
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "production must not allow blanket inline scripts");

  const styleSrc = policy.get("style-src");
  assert.match(styleSrc, /'unsafe-inline'/, "React style attributes need style-src 'unsafe-inline'");
  assert.match(styleSrc, /https:\/\/fonts\.googleapis\.com/);
  assert.match(policy.get("font-src"), /https:\/\/fonts\.gstatic\.com/);
  assert.match(policy.get("connect-src"), /https:\/\/\*\.razorpay\.com/);
  assert.match(policy.get("frame-src"), /https:\/\/\*\.razorpay\.com/);
});

test("the policy only allows the external origins the application actually uses", () => {
  const value = buildReportOnlyPolicy({ nonce: "TEST-NONCE" });
  const origins = [...value.matchAll(/https:\/\/[^\s;']+/g)].map((match) => match[0]);
  assert.deepEqual(
    [...new Set(origins)].sort(),
    [
      "https://*.razorpay.com",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ].sort(),
  );
});

test("development allowances never leak into the production policy", () => {
  const production = parsePolicy(buildReportOnlyPolicy({ nonce: "N", development: false }));
  const development = parsePolicy(buildReportOnlyPolicy({ nonce: "N", development: true }));

  assert.ok(!production.get("script-src").includes("'unsafe-eval'"));
  assert.ok(development.get("script-src").includes("'unsafe-eval'"));
  assert.ok(!production.get("connect-src").includes("ws:"));
  assert.ok(development.get("connect-src").includes("ws: wss:"));
  assert.ok(production.has("upgrade-insecure-requests"));
  assert.ok(!development.has("upgrade-insecure-requests"));
});

test("only non-breaking directives are enforced today", () => {
  const enforced = parsePolicy(buildEnforcedPolicy());
  assert.deepEqual(
    [...enforced.keys()].sort(),
    ["base-uri", "frame-ancestors", "object-src"],
  );
  assert.equal(enforced.get("frame-ancestors"), "'none'");
  assert.equal(enforced.get("object-src"), "'none'");
  assert.equal(enforced.get("base-uri"), "'self'");

  // Anything that can affect scripts, styles, fonts or the payment provider
  // must stay out of the enforced header until browser validation passes.
  for (const forbidden of [
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "connect-src",
    "frame-src",
    "form-action",
  ]) {
    assert.ok(!enforced.has(forbidden), `${forbidden} must not be enforced yet`);
  }

  // The enforced subset must agree with the full policy (no contradiction).
  const full = parsePolicy(buildReportOnlyPolicy({ nonce: "TEST-NONCE" }));
  for (const [name, value] of enforced) {
    assert.equal(full.get(name), value, `${name} differs between enforced and full policy`);
  }
});

test("the proxy forwards the nonce-bearing policy and emits only report-only", () => {
  const response = proxy(new Request("http://localhost:3000/student/documents"));

  // The enforced baseline is emitted by next.config.ts, not here: a nonce-less
  // response CSP would overwrite the forwarded request policy before Next
  // reads the nonce from it.
  assert.equal(response.headers.get("content-security-policy"), null);

  const reportOnly = response.headers.get("content-security-policy-report-only");
  assert.ok(reportOnly, "report-only policy must be present");
  const nonce = nonceOf(reportOnly);

  // These are the request headers Next consumes while rendering. They must
  // carry the same policy (and therefore the same nonce).
  assert.equal(response.headers.get("x-middleware-request-x-nonce"), nonce);
  assert.equal(
    response.headers.get("x-middleware-request-content-security-policy"),
    reportOnly,
  );
  const overrides = response.headers.get("x-middleware-override-headers") ?? "";
  assert.ok(overrides.split(",").includes("x-nonce"));
  assert.ok(overrides.split(",").includes("content-security-policy"));

  // The nonce must never leak as a browser-visible response header.
  assert.equal(response.headers.get("x-nonce"), null);
});

test("the proxy issues a fresh nonce on every request", () => {
  const first = nonceOf(proxy(new Request("http://localhost:3000/")).headers.get("content-security-policy-report-only"));
  const second = nonceOf(proxy(new Request("http://localhost:3000/")).headers.get("content-security-policy-report-only"));
  assert.notEqual(first, second);
});

test("each CSP header has exactly one source and no middleware duplicate exists", () => {
  const nextConfig = read("next.config.ts");
  assert.ok(
    nextConfig.includes('key: "Content-Security-Policy"'),
    "next.config.ts must emit the enforced baseline",
  );
  assert.ok(
    nextConfig.includes(`value: "${buildEnforcedPolicy()}"`),
    "next.config.ts baseline must match buildEnforcedPolicy()",
  );

  const proxySource = read("src/proxy.ts");
  assert.ok(
    !/headers\.set\(\s*"Content-Security-Policy"\s*,/.test(proxySource),
    "the proxy must not emit an enforced CSP header (it would hide the nonce)",
  );
  assert.ok(
    proxySource.includes('headers.set("Content-Security-Policy-Report-Only"'),
    "the proxy must emit the report-only policy",
  );
  assert.ok(proxySource.includes('requestHeaders.set("x-nonce"'));
  assert.ok(proxySource.includes('requestHeaders.set("Content-Security-Policy"'));

  assert.equal(exists("src/middleware.ts"), false);
  assert.equal(exists("middleware.ts"), false);
  assert.ok(!/export function middleware\b/.test(proxySource));
});

test("the proxy matcher covers pages and excludes non-document routes", () => {
  const serialized = JSON.stringify(config);
  assert.ok(serialized.includes("api"), "API routes must be excluded");
  assert.ok(serialized.includes("_next/static"), "build assets must be excluded");
  assert.ok(serialized.includes("favicon.ico"), "favicon must be excluded");
  assert.ok(serialized.includes("next-router-prefetch"), "prefetches must be skipped");
});

test("the public entry page renders per request so its nonce is applied", () => {
  assert.ok(/export const dynamic = "force-dynamic"/.test(read("src/app/page.tsx")));
});

test("existing security controls remain wired", () => {
  const download = read("src/app/api/documents/[id]/download/route.ts");
  assert.ok(download.includes("isDocumentDownloadable"), "download scan gate missing");

  const upload = read("src/app/api/documents/route.ts");
  assert.ok(upload.includes("scanQuarantinedDocument"), "upload scan lifecycle missing");
  assert.ok(upload.includes("QUARANTINED"), "upload must quarantine before release");

  const webhook = read("src/app/api/webhooks/razorpay/route.ts");
  assert.ok(webhook.includes("processRazorpayWebhook"), "webhook verification missing");

  assert.ok(read("src/lib/rate-limit.ts").includes("checkRateLimit"), "rate limiter missing");
  assert.ok(read("src/lib/document-scan.ts").includes("scanStatus"), "scan-state persistence missing");
  assert.ok(exists("src/lib/security/malware.ts"));
  assert.ok(exists("src/lib/security/clamav.ts"));
  assert.ok(exists("src/lib/authorization.ts"));
});

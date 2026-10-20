import test from "node:test";
import assert from "node:assert/strict";
import { resolveClientIp } from "../src/lib/request-ip.ts";

// Proxy headers are ignored unless TRUST_PROXY_HEADERS=true, and the value is
// advisory audit metadata only. These tests pin that contract.

function requestWith(headers) {
  return new Request("https://example.test/", { headers });
}

test("no request yields no client IP", () => {
  assert.equal(resolveClientIp(undefined, true), null);
});

test("proxy headers are ignored while trust is disabled", () => {
  const request = requestWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
  assert.equal(resolveClientIp(request, false), null);
});

test("the first forwarded entry is used when trust is enabled", () => {
  const request = requestWith({
    "x-forwarded-for": "  203.0.113.9 , 10.0.0.1",
    "x-real-ip": "10.0.0.1",
  });
  assert.equal(resolveClientIp(request, true), "203.0.113.9");
});

test("x-real-ip is the fallback when no forwarded entry exists", () => {
  const request = requestWith({ "x-real-ip": "198.51.100.7" });
  assert.equal(resolveClientIp(request, true), "198.51.100.7");
});

test("an empty first forwarded entry falls back to x-real-ip", () => {
  const request = requestWith({
    "x-forwarded-for": " , 10.0.0.1",
    "x-real-ip": "198.51.100.7",
  });
  assert.equal(resolveClientIp(request, true), "198.51.100.7");
});

test("values are truncated to 100 characters", () => {
  const request = requestWith({ "x-forwarded-for": "9".repeat(150) });
  assert.equal(resolveClientIp(request, true), "9".repeat(100));
});

test("the default trust decision follows TRUST_PROXY_HEADERS", () => {
  const previous = process.env.TRUST_PROXY_HEADERS;
  try {
    delete process.env.TRUST_PROXY_HEADERS;
    const request = requestWith({ "x-forwarded-for": "203.0.113.9" });
    assert.equal(resolveClientIp(request), null, "unset variable means no trust");

    process.env.TRUST_PROXY_HEADERS = "true";
    assert.equal(resolveClientIp(request), "203.0.113.9");

    process.env.TRUST_PROXY_HEADERS = "false";
    assert.equal(resolveClientIp(request), null, "explicit false means no trust");
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previous;
  }
});

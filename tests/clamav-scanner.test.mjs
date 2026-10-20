import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  ClamAvTransportError,
  createClamAvScanner,
  createClamAvTcpTransport,
  parseClamAvResponse,
} from "../src/lib/security/clamav.ts";

// ClamAV protocol/adapter tests. No live ClamAV daemon or external network is
// required: unit tests mock the transport, and one loopback test validates the
// INSTREAM framing against a small local TCP server.

const ENGINE = "clamav";

test("parses a verified clean clamd response", () => {
  assert.deepEqual(parseClamAvResponse("stream: OK\0", ENGINE), {
    status: "CLEAN",
    engine: ENGINE,
  });
  assert.deepEqual(parseClamAvResponse("  stream: OK  \r\n", ENGINE), {
    status: "CLEAN",
    engine: ENGINE,
  });
});

test("parses an infected clamd response and keeps only the signature", () => {
  assert.deepEqual(
    parseClamAvResponse("stream: Eicar-Test-Signature FOUND\0", ENGINE),
    {
      status: "INFECTED",
      engine: ENGINE,
      signature: "Eicar-Test-Signature",
    },
  );
});

test("scanner errors and malformed responses fail closed", () => {
  for (const raw of [
    "INSTREAM size limit exceeded. ERROR\0",
    "",
    "garbage",
    "stream: FOUND\0",
    "2000 bytes read",
  ]) {
    const result = parseClamAvResponse(raw, ENGINE);
    assert.equal(result.status, "ERROR", `raw=${JSON.stringify(raw)}`);
    assert.notEqual(result.status, "CLEAN");
  }
});

test("oversized input is rejected before the transport is called", async () => {
  let called = false;
  const scanner = createClamAvScanner({
    maxBytes: 4,
    transport: {
      async scan() {
        called = true;
        return "stream: OK\0";
      },
    },
  });

  const result = await scanner.scan({ bytes: Buffer.from("12345") });
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "size_exceeded");
  assert.equal(called, false);
});

test("transport timeouts and connection failures map to typed errors", async () => {
  for (const reason of ["timeout", "connect_failed", "transport_error"]) {
    const scanner = createClamAvScanner({
      transport: {
        async scan() {
          throw new ClamAvTransportError(reason);
        },
      },
    });
    const result = await scanner.scan({ bytes: Buffer.from("data") });
    assert.equal(result.status, "ERROR");
    assert.equal(result.reason, reason);
  }
});

test("unexpected transport exceptions fail closed as transport_error", async () => {
  const scanner = createClamAvScanner({
    transport: {
      async scan() {
        throw new Error("socket exploded");
      },
    },
  });
  const result = await scanner.scan({ bytes: Buffer.from("data") });
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "transport_error");
});

async function startFramingServer(response) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let commandSeen = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandSeen) {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        assert.equal(buffer.subarray(0, nul).toString("ascii"), "zINSTREAM");
        buffer = buffer.subarray(nul + 1);
        commandSeen = true;
      }
      while (buffer.byteLength >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          socket.write(`${response}\0`);
          return;
        }
        if (buffer.byteLength < 4 + length) return;
        received.push(Buffer.from(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: address.port,
    received,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("TCP transport sends exact INSTREAM bytes and parses a clean response", async () => {
  const server = await startFramingServer("stream: OK");
  try {
    const bytes = Buffer.from("exact stored bytes \u0000 with a NUL inside");
    const transport = createClamAvTcpTransport({
      host: "127.0.0.1",
      port: server.port,
    });
    const scanner = createClamAvScanner({ transport, timeoutMs: 2_000 });
    const result = await scanner.scan({ bytes });

    assert.deepEqual(result, { status: "CLEAN", engine: ENGINE });
    assert.equal(Buffer.concat(server.received).equals(bytes), true);
  } finally {
    await server.close();
  }
});

test("TCP transport times out when a scanner never responds", async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      // Deliberately never respond.
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const transport = createClamAvTcpTransport({
      host: "127.0.0.1",
      port: address.port,
    });
    const scanner = createClamAvScanner({ transport, timeoutMs: 200 });
    const startedAt = Date.now();
    const result = await scanner.scan({ bytes: Buffer.from("data") });
    assert.equal(result.status, "ERROR");
    assert.equal(result.reason, "timeout");
    assert.ok(Date.now() - startedAt < 2_000, "timeout must be bounded");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("TCP transport reports connection refusal without hanging", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));

  const transport = createClamAvTcpTransport({
    host: "127.0.0.1",
    port: address.port,
  });
  const scanner = createClamAvScanner({ transport, timeoutMs: 1_000 });
  const result = await scanner.scan({ bytes: Buffer.from("data") });
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "connect_failed");
});

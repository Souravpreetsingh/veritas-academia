// ClamAV (clamd) adapter.
//
// clamd is a long-running antivirus daemon. We speak its INSTREAM protocol over
// a private TCP connection: send `zINSTREAM\0`, then length-prefixed chunks,
// then a zero-length chunk. The daemon replies with a NUL-terminated line such
// as `stream: OK` or `stream: Eicar-Test-Signature FOUND`.
//
// No scanner binary is bundled with this application. If a deployment does not
// run clamd (or the web service cannot reach it), every scan fails closed and
// documents remain quarantined. See docs/deployment-render.md §7.

import net from "node:net";
import { MAX_UPLOAD_BYTES } from "@/lib/storage/types";
import type {
  MalwareScanOutcome,
  MalwareScanner,
  MalwareScanErrorReason,
} from "./malware";

export const CLAMAV_DEFAULT_PORT = 3310;
export const CLAMAV_DEFAULT_TIMEOUT_MS = 10_000;
export const CLAMAV_MIN_TIMEOUT_MS = 1_000;
export const CLAMAV_MAX_TIMEOUT_MS = 60_000;

const INSTREAM_COMMAND = Buffer.from("zINSTREAM\0", "ascii");
const INSTREAM_TERMINATOR = Buffer.alloc(4);
const CHUNK_SIZE = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;

export type ClamAvTransportFailure =
  | "timeout"
  | "connect_failed"
  | "transport_error";

export class ClamAvTransportError extends Error {
  readonly reason: ClamAvTransportFailure;

  constructor(reason: ClamAvTransportFailure, message?: string) {
    super(message ?? `ClamAV transport failure: ${reason}`);
    this.name = "ClamAvTransportError";
    this.reason = reason;
  }
}

/**
 * Seam for tests and future transports. Returns the raw clamd response; the
 * scanner is responsible for parsing it into a typed outcome.
 */
export interface ClamAvTransport {
  scan(bytes: Uint8Array, options: { timeoutMs: number }): Promise<string>;
}

interface TcpTransportOptions {
  host: string;
  port: number;
}

async function writeWithBackpressure(
  socket: net.Socket,
  data: Uint8Array,
): Promise<void> {
  if (socket.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before the scan request was written."));
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * TCP transport for clamd INSTREAM. Connect and total-scan timeouts are both
 * bounded; the socket is always destroyed on completion or failure.
 */
export function createClamAvTcpTransport({
  host,
  port,
}: TcpTransportOptions): ClamAvTransport {
  return {
    async scan(bytes, { timeoutMs }) {
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        let connected = false;
        const responseChunks: Buffer[] = [];

        const socket = net.createConnection({ host, port });
        const connectTimer = setTimeout(
          () => fail(new ClamAvTransportError("timeout", "ClamAV connect timed out.")),
          Math.min(CONNECT_TIMEOUT_MS, timeoutMs),
        );
        const scanTimer = setTimeout(
          () => fail(new ClamAvTransportError("timeout", "ClamAV scan timed out.")),
          timeoutMs,
        );

        function cleanup() {
          clearTimeout(connectTimer);
          clearTimeout(scanTimer);
          socket.removeAllListeners();
          socket.destroy();
        }

        function succeed(raw: string) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(raw);
        }

        function fail(error: ClamAvTransportError) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }

        async function send(): Promise<void> {
          await writeWithBackpressure(socket, INSTREAM_COMMAND);
          for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
            const chunk = bytes.subarray(
              offset,
              Math.min(offset + CHUNK_SIZE, bytes.byteLength),
            );
            const header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(chunk.byteLength, 0);
            await writeWithBackpressure(socket, header);
            await writeWithBackpressure(socket, chunk);
          }
          await writeWithBackpressure(socket, INSTREAM_TERMINATOR);
        }

        socket.on("connect", () => {
          connected = true;
          clearTimeout(connectTimer);
          send().catch(() => {
            fail(new ClamAvTransportError("transport_error"));
          });
        });

        socket.on("data", (chunk: Buffer) => {
          if (settled) return;
          responseChunks.push(Buffer.from(chunk));
          const buffered = Buffer.concat(responseChunks);
          if (buffered.byteLength > MAX_RESPONSE_BYTES) {
            fail(new ClamAvTransportError("transport_error", "ClamAV response too large."));
            return;
          }
          const terminator = buffered.indexOf(0);
          if (terminator !== -1) {
            succeed(buffered.subarray(0, terminator).toString("utf8"));
          }
        });

        socket.on("end", () => {
          // Some clamd builds close the connection without a trailing NUL. Let
          // the parser mark an unterminated/unknown response as malformed.
          succeed(Buffer.concat(responseChunks).toString("utf8"));
        });

        socket.on("error", () => {
          fail(
            new ClamAvTransportError(
              connected ? "transport_error" : "connect_failed",
            ),
          );
        });

        socket.on("close", () => {
          if (!settled) {
            if (responseChunks.length > 0) {
              succeed(Buffer.concat(responseChunks).toString("utf8"));
            } else {
              fail(new ClamAvTransportError("transport_error"));
            }
          }
        });
      });
    },
  };
}

/**
 * Parse a clamd INSTREAM response. Unknown or partial responses are errors,
 * never clean. Signature names are diagnostic metadata, not document content.
 */
export function parseClamAvResponse(
  raw: string,
  engine = "clamav",
): MalwareScanOutcome {
  const text = raw.replace(/\0+$/g, "").trim();

  if (/^stream: OK$/i.test(text)) {
    return { status: "CLEAN", engine };
  }

  const found = /^stream: (.+) FOUND$/i.exec(text);
  if (found) {
    const signature = found[1]
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 128);
    if (signature) {
      return { status: "INFECTED", engine, signature };
    }
    return { status: "ERROR", engine, reason: "malformed_response" };
  }

  if (/\bERROR$/i.test(text)) {
    return { status: "ERROR", engine, reason: "scanner_error" };
  }

  return { status: "ERROR", engine, reason: "malformed_response" };
}

export interface ClamAvScannerOptions {
  transport: ClamAvTransport;
  timeoutMs?: number;
  maxBytes?: number;
  engine?: string;
}

function transportFailureReason(error: unknown): MalwareScanErrorReason {
  if (error instanceof ClamAvTransportError) return error.reason;
  return "transport_error";
}

/**
 * Build a scanner around a transport. The size limit mirrors the upload cap so
 * the daemon is never asked to buffer more than the application accepted.
 */
export function createClamAvScanner({
  transport,
  timeoutMs = CLAMAV_DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_UPLOAD_BYTES,
  engine = "clamav",
}: ClamAvScannerOptions): MalwareScanner {
  return {
    id: engine,
    configured: true,
    async scan({ bytes }) {
      if (bytes.byteLength === 0) {
        return { status: "ERROR", engine, reason: "malformed_response" };
      }
      if (bytes.byteLength > maxBytes) {
        return { status: "ERROR", engine, reason: "size_exceeded" };
      }

      let raw: string;
      try {
        raw = await transport.scan(bytes, { timeoutMs });
      } catch (error) {
        return {
          status: "ERROR",
          engine,
          reason: transportFailureReason(error),
        };
      }

      return parseClamAvResponse(raw, engine);
    },
  };
}

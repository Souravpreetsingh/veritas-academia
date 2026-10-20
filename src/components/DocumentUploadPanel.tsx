"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Real document upload form for the student documents page.
//
// Posts multipart/form-data to the authenticated POST /api/documents endpoint
// (the same endpoint used everywhere else), then refreshes the server-rendered
// list. The server remains authoritative for type, size and scan status; this
// component only reports what actually happened.

const ACCEPT = ".pdf,.doc,.docx,.odt,.rtf,.txt";
const INPUT_ID = "document-upload-file";

type UploadStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

export default function DocumentUploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = inputRef.current;
    const file = input?.files?.[0] ?? null;
    if (!file) {
      setStatus({ kind: "error", message: "Choose a file to upload." });
      return;
    }

    setStatus({ kind: "busy" });
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/documents", { method: "POST", body });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
      };

      if (!response.ok) {
        setStatus({
          kind: "error",
          message: payload.error ?? "The upload failed. Please try again.",
        });
        return;
      }

      if (input) input.value = "";
      setStatus({
        kind: "done",
        message:
          payload.status === "AVAILABLE"
            ? "Uploaded and cleared by the security scan."
            : "Uploaded. The file is quarantined until a security scan clears it.",
      });
      router.refresh();
    } catch {
      setStatus({
        kind: "error",
        message: "The upload could not be completed. Check your connection and try again.",
      });
    }
  }

  const busy = status.kind === "busy";

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl bg-surface-container/60 border border-outline-variant/40 p-5 space-y-4"
    >
      <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
        <span aria-hidden="true" className="material-symbols-outlined text-secondary text-lg">
          upload_file
        </span>
        Upload a document
      </h2>

      <div className="space-y-2">
        <label
          htmlFor={INPUT_ID}
          className="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant"
        >
          File
        </label>
        <input
          ref={inputRef}
          id={INPUT_ID}
          name="file"
          type="file"
          accept={ACCEPT}
          required
          disabled={busy}
          className="block w-full text-xs font-body text-on-surface-variant file:mr-3 file:px-3 file:py-2 file:rounded file:border-0 file:bg-surface-container-high file:text-on-surface file:text-xs file:font-headline file:font-semibold hover:file:bg-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:opacity-50"
        />
        <p className="text-[11px] font-body text-on-surface-variant">
          PDF, DOC, DOCX, ODT, RTF or TXT · up to 25 MB.
        </p>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-sm">
          {busy ? "hourglass_top" : "cloud_upload"}
        </span>
        {busy ? "Uploading…" : "Upload"}
      </button>

      <div aria-live="polite" role="status" className="min-h-[1rem]">
        {status.kind === "error" ? (
          <p className="flex items-start gap-2 text-xs font-body text-error">
            <span aria-hidden="true" className="material-symbols-outlined text-sm mt-0.5">
              error
            </span>
            {status.message}
          </p>
        ) : null}
        {status.kind === "done" ? (
          <p className="flex items-start gap-2 text-xs font-body text-secondary">
            <span aria-hidden="true" className="material-symbols-outlined text-sm mt-0.5">
              check_circle
            </span>
            {status.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

"use client";

import { useEffect } from "react";

// Progressive enhancement for the static Stitch "Upload your documents" screen.
//
// The generated screen is a visual mock with no real file controls, so this
// component wires its existing "Browse Workstation" button and drag-and-drop
// zone to the authenticated POST /api/documents endpoint. It manipulates the
// DOM directly (rather than re-rendering the screen) to preserve the original
// Stitch markup, and it degrades silently if those elements are ever changed.

const ACCEPT = ".pdf,.doc,.docx,.odt,.rtf,.txt";

interface UploadResponse {
  id?: string;
  status?: string;
  error?: string;
}

export default function DocumentUploadEnhancer() {
  useEffect(() => {
    const browseButton = Array.from(document.querySelectorAll("button")).find((element) =>
      /browse workstation/i.test(element.textContent ?? ""),
    );
    const heading = Array.from(document.querySelectorAll("h3")).find((element) =>
      /drag and drop/i.test(element.textContent ?? ""),
    );
    const dropzone = heading?.parentElement ?? null;

    if (!browseButton && !dropzone) return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.multiple = true;
    input.style.display = "none";

    const status = document.createElement("div");
    status.className = "mt-4 flex flex-col gap-2";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const mountTarget = dropzone?.parentElement ?? dropzone ?? document.body;
    mountTarget.appendChild(status);

    function makeRow(name: string): HTMLSpanElement {
      const row = document.createElement("div");
      row.className =
        "flex items-center justify-between gap-3 p-3 rounded bg-surface-container-high border border-outline-variant/40 text-sm";
      const label = document.createElement("span");
      label.className = "text-on-surface truncate";
      label.textContent = name;
      const state = document.createElement("span");
      state.className = "text-on-surface-variant whitespace-nowrap";
      state.textContent = "Uploading…";
      row.append(label, state);
      status.appendChild(row);
      return state;
    }

    function setResult(
      target: HTMLSpanElement,
      message: string,
      tone: "ok" | "warn" | "error",
    ) {
      const tones: Record<typeof tone, string> = {
        ok: "text-secondary",
        warn: "text-tertiary",
        error: "text-error",
      };
      target.className = tones[tone] + " whitespace-nowrap";
      target.textContent = message;
    }

    async function uploadOne(file: File) {
      const target = makeRow(file.name);
      try {
        const body = new FormData();
        body.append("file", file);
        const response = await fetch("/api/documents", { method: "POST", body });
        const payload = (await response.json().catch(() => ({}))) as UploadResponse;

        if (response.status === 401 || response.status === 403) {
          setResult(target, "Sign in required", "error");
          return;
        }
        if (!response.ok) {
          setResult(target, payload.error ?? "Upload failed", "error");
          return;
        }
        if (payload.status === "AVAILABLE") {
          setResult(target, "Uploaded", "ok");
        } else {
          setResult(target, "Held for security scan", "warn");
        }
      } catch {
        setResult(target, "Network error", "error");
      }
    }

    async function handleFiles(files: FileList | null | undefined) {
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        await uploadOne(file);
      }
    }

    const onBrowseClick = (event: Event) => {
      event.preventDefault();
      input.click();
    };
    const onInputChange = () => {
      void handleFiles(input.files);
      input.value = "";
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      void handleFiles(event.dataTransfer?.files);
    };

    browseButton?.addEventListener("click", onBrowseClick);
    input.addEventListener("change", onInputChange);
    dropzone?.addEventListener("dragover", onDragOver);
    dropzone?.addEventListener("drop", onDrop);

    document.body.appendChild(input);

    return () => {
      browseButton?.removeEventListener("click", onBrowseClick);
      input.removeEventListener("change", onInputChange);
      dropzone?.removeEventListener("dragover", onDragOver);
      dropzone?.removeEventListener("drop", onDrop);
      input.remove();
      status.remove();
    };
  }, []);

  return null;
}

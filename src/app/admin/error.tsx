"use client";

import { useEffect } from "react";

// Error boundary for admin screens. Unexpected failures show a safe fallback;
// expected outcomes (empty queue, filtered results) are handled by the pages.
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="max-w-xl rounded-xl bg-surface-container border border-error/40 p-8 space-y-4">
      <div className="flex items-center gap-2 text-error font-headline font-bold">
        <span className="material-symbols-outlined">error</span>
        Admin data could not be loaded
      </div>
      <p className="text-sm font-body text-on-surface-variant">
        Something went wrong while reading administrator data. No records were changed.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="inline-flex items-center gap-2 px-4 py-2 rounded bg-primary text-on-primary text-xs font-headline font-semibold hover:bg-primary-container transition-colors"
      >
        <span className="material-symbols-outlined text-base">refresh</span>
        Try again
      </button>
    </div>
  );
}

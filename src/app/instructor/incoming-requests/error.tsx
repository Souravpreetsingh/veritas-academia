"use client";

import { useEffect } from "react";
import Shell from "@/components/Shell";

// Error boundary for the instructor inbox. Unexpected failures show a safe
// fallback; expected outcomes (empty inbox, filtered results) are handled by
// the page itself.
export default function IncomingRequestsError({
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
    <Shell
      persona="instructor"
      label="Incoming Requests"
      group="incoming-requests"
      mainClassName="w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
    >
      <div className="max-w-xl rounded-xl bg-surface-container border border-error/40 p-8 space-y-4">
        <div className="flex items-center gap-2 text-error font-headline font-bold">
          <span className="material-symbols-outlined">error</span>
          Incoming requests could not be loaded
        </div>
        <p className="text-sm font-body text-on-surface-variant">
          Something went wrong while reading your request queue. No data was changed.
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
    </Shell>
  );
}

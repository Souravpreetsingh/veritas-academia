import Shell from "@/components/Shell";

// Streamed loading state for the instructor inbox.
export default function IncomingRequestsLoading() {
  return (
    <Shell
      persona="instructor"
      label="Incoming Requests"
      group="incoming-requests"
      mainClassName="w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
    >
      <div className="animate-pulse space-y-6" aria-busy="true" aria-label="Loading incoming requests">
        <div className="h-7 w-64 rounded bg-surface-container-high/70" />
        <div className="h-3.5 w-96 max-w-full rounded bg-surface-container-high/50" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="h-16 rounded bg-surface-container/70" />
          ))}
        </div>
        <div className="h-9 w-72 max-w-full rounded bg-surface-container-high/40" />
        <div className="rounded-xl bg-surface-container/50 border border-outline-variant/30 p-4 space-y-3">
          {[0, 1, 2, 3, 4].map((key) => (
            <div key={key} className="h-12 rounded bg-surface-container-high/40" />
          ))}
        </div>
      </div>
    </Shell>
  );
}

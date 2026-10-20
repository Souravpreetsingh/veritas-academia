import Shell from "@/components/Shell";

// Streamed loading state for the instructor request detail.
export default function InstructorRequestDetailLoading() {
  return (
    <Shell
      persona="instructor"
      label="Request"
      group="incoming-requests"
      mainClassName="w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
    >
      <div
        className="max-w-6xl animate-pulse space-y-6"
        aria-busy="true"
        aria-label="Loading request details"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="h-8 w-56 rounded bg-surface-container-high/60" />
          <div className="h-6 w-28 rounded bg-surface-container-high/40" />
        </div>
        <div className="h-8 w-2/3 max-w-xl rounded bg-surface-container-high/70" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="h-40 rounded-xl bg-surface-container/60" />
            <div className="h-52 rounded-xl bg-surface-container/60" />
          </div>
          <div className="space-y-5">
            <div className="h-36 rounded-xl bg-surface-container/60" />
            <div className="h-64 rounded-xl bg-surface-container/60" />
          </div>
        </div>
      </div>
    </Shell>
  );
}

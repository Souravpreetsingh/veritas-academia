// Streamed loading state for the admin dashboard.
export default function AdminLoading() {
  return (
    <div
      className="animate-pulse space-y-6"
      aria-busy="true"
      aria-label="Loading administrator data"
    >
      <div className="space-y-2">
        <div className="h-7 w-56 rounded bg-surface-container-high/70" />
        <div className="h-3.5 w-80 max-w-full rounded bg-surface-container-high/50" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {[0, 1, 2, 3].map((key) => (
          <div key={key} className="h-24 rounded bg-surface-container/70" />
        ))}
      </div>
      <div className="rounded-xl bg-surface-container/50 border border-outline-variant/30 p-4 space-y-3">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-12 rounded bg-surface-container-high/40" />
        ))}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

// Explicit account switching. Auth.js performs the CSRF-protected sign-out and
// then returns the visitor to the public landing page.
export default function SignOutButton({
  className,
  label = "Sign out",
  iconOnly = false,
}: {
  className?: string;
  label?: string;
  iconOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      title={label}
      aria-label={label}
      onClick={async () => {
        setBusy(true);
        try {
          await signOut({ callbackUrl: "/" });
        } finally {
          setBusy(false);
        }
      }}
      className={
        className ??
        "rounded px-2 py-1 text-xs font-label text-on-surface-variant transition-colors hover:text-secondary disabled:opacity-50"
      }
    >
      {iconOnly ? (
        <span className="material-symbols-outlined text-base">logout</span>
      ) : busy ? (
        "Signing out…"
      ) : (
        label
      )}
    </button>
  );
}

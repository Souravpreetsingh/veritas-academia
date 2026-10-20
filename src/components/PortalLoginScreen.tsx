import Link from "next/link";
import PortalLoginForm from "@/components/PortalLoginForm";
import SignOutButton from "@/components/SignOutButton";
import { homePathForRole, type Role } from "@/lib/domain";
import type { Portal } from "@/lib/login-routing";

// Server-rendered shell for both portal sign-in screens. No client hooks here so
// it stays a server component; only the credential form is interactive.

const COPY: Record<
  Portal,
  { eyebrow: string; title: string; subtitle: string; accent: string }
> = {
  student: {
    eyebrow: "Student Portal",
    title: "Sign in to your workspace",
    subtitle:
      "Access your manuscripts, originality reports and revision workspace. Verified academic-integrity tooling only.",
    accent: "text-secondary neon-text-cyan",
  },
  instructor: {
    eyebrow: "Instructor Portal",
    title: "Sign in to the instructor workspace",
    subtitle:
      "Review incoming requests, deliver analyses and manage your teaching engagement with verified students.",
    accent: "text-primary neon-text-pink",
  },
};

const ROLE_LABEL: Record<Role, string> = {
  STUDENT: "a student",
  INSTRUCTOR: "an instructor",
  ADMIN: "an administrator",
};

export default function PortalLoginScreen({
  portal,
  next,
  signedInRole,
}: {
  portal: Portal;
  next?: string;
  signedInRole?: Role | null;
}) {
  const copy = COPY[portal];

  return (
    <div className="relative min-h-screen overflow-hidden bg-background font-body">
      <div className="pointer-events-none fixed -z-10 top-0 left-1/4 h-[420px] w-[560px] rounded-full bg-brand-cyan/10 blur-[140px] animate-pulse-subtle" />
      <div
        className="pointer-events-none fixed -z-10 bottom-0 right-1/4 h-[380px] w-[520px] rounded-full bg-brand-magenta/10 blur-[150px] animate-pulse-subtle"
        style={{ animationDelay: "2s" }}
      />

      <header className="glass-nav sticky top-0 z-50 w-full border-b border-outline-variant/30">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-brand-magenta to-brand-purple p-[1px]">
              <span className="flex h-full w-full items-center justify-center rounded-[3px] bg-surface-container-lowest">
                <span className="material-symbols-outlined text-[18px] text-brand-magenta">
                  verified_user
                </span>
              </span>
            </span>
            <span className="font-headline text-sm font-bold tracking-wider text-on-surface">
              VERITAS <span className="text-primary">ACADEMIA</span>
            </span>
          </Link>
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-label text-on-surface-variant transition-colors hover:text-secondary"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            Back to homepage
          </Link>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center px-6 py-12">
        <div className="w-full">
          <div className="mb-8 text-center">
            <div className="mb-2 font-label text-[10px] uppercase tracking-[0.25em] text-on-surface-variant">
              {copy.eyebrow}
            </div>
            <h1 className="font-headline text-2xl font-bold tracking-tight text-on-surface">
              {copy.title}
            </h1>
            <p className="mt-2 text-sm text-on-surface-variant">{copy.subtitle}</p>
          </div>

          {signedInRole ? (
            <div className="mb-4 rounded border border-tertiary/40 bg-tertiary-container/20 p-4 text-sm">
              <p className="text-on-surface">
                You are already signed in as {ROLE_LABEL[signedInRole]}.
              </p>
              <p className="mt-1 text-xs text-on-surface-variant">
                Sign in below to replace the current session, or continue to your own portal.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <Link
                  href={homePathForRole(signedInRole)}
                  className="text-xs font-label text-secondary hover:underline"
                >
                  Continue to your portal
                </Link>
                <SignOutButton
                  label="Sign out"
                  className="text-xs font-label text-on-surface-variant underline hover:text-error"
                />
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-outline-variant/40 bg-surface-container p-8">
            <PortalLoginForm portal={portal} next={next} />
          </div>

          <p className="mt-6 text-center text-xs text-on-surface-variant">
            Separate portals share one secure account. Access is enforced on the server for each
            role.
          </p>
        </div>
      </main>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import InstructorApplicationForm from "@/components/InstructorApplicationForm";
import { homePathForRole } from "@/lib/domain";
import { getSessionUser } from "@/lib/session";

export const metadata = { title: "Instructor application — Veritas Academia" };

// Public instructor onboarding. Creates a unified account plus a PENDING
// instructor application; approval by an administrator is still required
// before any instructor capability is granted.
export default async function InstructorRegisterPage() {
  const user = await getSessionUser();
  if (user) {
    redirect(user.role === "STUDENT" ? "/instructor/application" : homePathForRole(user.role));
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background font-body">
      <div className="pointer-events-none fixed -z-10 top-0 left-1/4 h-[420px] w-[560px] rounded-full bg-brand-magenta/10 blur-[140px]" />
      <div
        className="pointer-events-none fixed -z-10 bottom-0 right-1/4 h-[380px] w-[520px] rounded-full bg-brand-cyan/10 blur-[150px]"
        style={{ animationDelay: "2s" }}
      />

      <header className="glass-nav sticky top-0 z-50 w-full border-b border-outline-variant/30">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-6">
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
            href="/instructor/login"
            className="text-xs font-label text-on-surface-variant transition-colors hover:text-secondary"
          >
            Instructor sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-8">
          <div className="mb-2 font-label text-[10px] uppercase tracking-[0.25em] text-primary">
            Instructor Onboarding
          </div>
          <h1 className="font-headline text-3xl font-bold tracking-tight text-on-surface">
            Apply to teach at Veritas Academia
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-on-surface-variant">
            Submit your instructor application directly — no student registration required. An
            administrator reviews every application, and instructor features unlock only after
            approval. You can sign in at any time to track your application status.
          </p>
        </div>

        <div className="rounded-lg border border-outline-variant/40 bg-surface-container p-8">
          <InstructorApplicationForm mode="register" />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-xs text-on-surface-variant">
          <p>
            Looking for a student account?{" "}
            <Link href="/register" className="text-secondary hover:underline">
              Student registration
            </Link>
          </p>
          <p>
            Already applied?{" "}
            <Link href="/instructor/application" className="text-secondary hover:underline">
              Check your application status
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import InstructorApplicationForm from "@/components/InstructorApplicationForm";
import SignOutButton from "@/components/SignOutButton";
import { getSessionUser } from "@/lib/session";

export const metadata = { title: "Instructor application status — Veritas Academia" };

// Account-level status screen for prospective instructors. Lives in the (auth)
// group so it is not wrapped by the protected /instructor layout. A pending
// applicant is still a STUDENT account; the status screen never grants any
// instructor capability.
export default async function InstructorApplicationStatusPage() {
  const user = await getSessionUser();
  if (!user) redirect("/instructor/login?next=%2Finstructor%2Fapplication");
  if (user.role !== "STUDENT") redirect("/instructor");

  return (
    <div className="relative min-h-screen overflow-hidden bg-background font-body">
      <div className="pointer-events-none fixed -z-10 top-0 left-1/4 h-[420px] w-[560px] rounded-full bg-brand-cyan/10 blur-[140px]" />
      <div
        className="pointer-events-none fixed -z-10 bottom-0 right-1/4 h-[380px] w-[520px] rounded-full bg-brand-magenta/10 blur-[150px]"
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
            href="/student"
            className="text-xs font-label text-on-surface-variant transition-colors hover:text-secondary"
          >
            Student workspace
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-6">
          <div className="mb-2 font-label text-[10px] uppercase tracking-[0.25em] text-primary">
            Instructor Onboarding
          </div>
          <h1 className="font-headline text-3xl font-bold tracking-tight text-on-surface">
            Your instructor application
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-on-surface-variant">
            Instructor features unlock only after an administrator approves your application.
            Pending and rejected applicants cannot access the instructor workspace. Your application
            stays on file, and you can sign out and return later.
          </p>
        </div>

        <div className="rounded-lg border border-outline-variant/40 bg-surface-container p-8">
          <InstructorApplicationForm />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-xs text-on-surface-variant">
          <Link href="/student" className="text-secondary hover:underline">
            Continue to the student workspace
          </Link>
          <SignOutButton
            label="Sign out"
            className="text-xs font-label text-on-surface-variant underline hover:text-error"
          />
        </div>
      </main>
    </div>
  );
}

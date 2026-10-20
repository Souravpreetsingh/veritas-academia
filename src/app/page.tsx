import Link from "next/link";

// Public entry point. Deliberately focused on ONE decision — which portal to
// enter. No dashboards, marketplace, pricing or application features are shown
// here. The two portals authenticate against the same secure account system.
export const metadata = {
  title: "Veritas Academia — Academic Integrity Platform",
  description:
    "Veritas Academia is an academic-integrity platform connecting verified students with approved instructors for originality analysis, auditing and revision.",
};

// The CSP nonce is only attached while server-rendering (see src/proxy.ts),
// so the public entry page must render per request for its framework scripts
// to carry the nonce.
export const dynamic = "force-dynamic";

const PORTALS = [
  {
    key: "student",
    href: "/student/login",
    eyebrow: "For students",
    title: "Student Portal",
    description:
      "Submit manuscripts, run originality and AI-writing analysis, request verified academic support and track revisions through to delivery.",
    cta: "Sign in as Student",
    icon: "school",
    accentText: "text-secondary neon-text-cyan",
    accentBorder: "hover:border-secondary/60",
    accentGlow: "hover:shadow-[0_0_28px_rgba(0,255,204,0.18)]",
    iconColor: "text-secondary",
    button: "bg-secondary text-background",
    secondary: { href: "/register", label: "Create a student account" },
  },
  {
    key: "instructor",
    href: "/instructor/login",
    eyebrow: "For instructors",
    title: "Instructor Portal",
    description:
      "Review incoming requests, conduct similarity and AI-detection analysis, deliver expert feedback and manage your teaching engagement.",
    cta: "Sign in as Instructor",
    icon: "workspace_premium",
    accentText: "text-primary neon-text-pink",
    accentBorder: "hover:border-primary/60",
    accentGlow: "hover:shadow-[0_0_28px_rgba(255,45,120,0.18)]",
    iconColor: "text-primary",
    button: "bg-primary text-on-primary",
    secondary: { href: "/instructor/register", label: "Apply to teach" },
  },
] as const;

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-surface-base text-on-surface font-body antialiased">
      {/* Ambient decorative glows */}
      <div className="pointer-events-none fixed -z-10 top-0 left-1/4 h-[460px] w-[600px] rounded-full bg-brand-cyan/10 blur-[140px] animate-pulse-subtle" />
      <div
        className="pointer-events-none fixed -z-10 top-1/3 right-10 h-[440px] w-[560px] rounded-full bg-brand-magenta/10 blur-[150px] animate-pulse-subtle"
        style={{ animationDelay: "2s" }}
      />
      <div className="pointer-events-none fixed -z-10 bottom-0 left-10 h-[360px] w-[460px] rounded-full bg-brand-purple/10 blur-[120px]" />
      <div className="pointer-events-none fixed inset-0 -z-10 grid-bg opacity-40" />

      <header className="sticky top-0 z-50 w-full glass-nav border-b border-outline-variant/30">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded bg-gradient-to-br from-brand-magenta to-brand-purple p-[1px]">
              <span className="flex h-full w-full items-center justify-center rounded-[3px] bg-surface-container-lowest">
                <span className="material-symbols-outlined text-[18px] text-brand-magenta">
                  verified_user
                </span>
              </span>
            </span>
            <div className="flex flex-col leading-none">
              <span className="font-headline text-sm font-bold tracking-wider text-on-surface">
                VERITAS <span className="text-primary">ACADEMIA</span>
              </span>
              <span className="mt-1 font-label text-[9px] uppercase tracking-[0.25em] text-on-surface-variant">
                Academic Integrity Grid
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col justify-center px-6 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded border border-outline-variant/40 bg-surface-container/60 px-3 py-1.5 font-label text-[10px] uppercase tracking-[0.25em] text-on-surface-variant">
            <span className="h-1.5 w-1.5 rounded-full bg-secondary shadow-[0_0_8px_#00ffcc]" />
            Verified Academic Integrity Platform
          </div>
          <h1 className="font-headline text-4xl font-bold leading-tight tracking-tight text-on-surface sm:text-5xl">
            Veritas <span className="text-primary neon-text-pink">Academia</span>
          </h1>
          <p className="mt-3 font-headline text-lg font-semibold text-on-surface-variant sm:text-xl">
            Uphold the integrity of every manuscript.
          </p>
          <p className="mx-auto mt-4 max-w-xl text-base text-on-surface-variant">
            Veritas Academia connects students with approved academic instructors for originality
            analysis, integrity auditing and revision — grounded in verified credentials and
            transparent review.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
          {PORTALS.map((portal) => (
            <div
              key={portal.key}
              className={`group flex flex-col rounded-lg border border-outline-variant/40 bg-surface-container/70 p-7 transition-all duration-200 ${portal.accentBorder} ${portal.accentGlow}`}
            >
              <div className="mb-5 flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded bg-surface-container-high border border-outline-variant/40">
                  <span className={`material-symbols-outlined text-[22px] ${portal.iconColor}`}>
                    {portal.icon}
                  </span>
                </span>
                <span
                  className={`font-label text-[10px] uppercase tracking-[0.25em] ${portal.accentText}`}
                >
                  {portal.eyebrow}
                </span>
              </div>

              <h2 className="font-headline text-xl font-bold text-on-surface">{portal.title}</h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-on-surface-variant">
                {portal.description}
              </p>

              <Link
                href={portal.href}
                className={`mt-6 flex items-center justify-center gap-2 rounded px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 ${portal.button}`}
              >
                {portal.cta}
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </Link>
              <Link
                href={portal.secondary.href}
                className="mt-3 text-center text-xs font-label text-on-surface-variant transition-colors hover:text-secondary"
              >
                {portal.secondary.label}
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-sm text-on-surface-variant">
          New to Veritas Academia?{" "}
          <Link href="/register" className="text-secondary hover:underline">
            Create a student account
          </Link>
          <span className="mx-2 text-outline-variant">•</span>
          <Link href="/instructor/register" className="text-secondary hover:underline">
            Apply to teach
          </Link>
          <span className="mx-2 text-outline-variant">•</span>
          <span className="text-xs">
            Instructor access is granted after an approved application.
          </span>
        </p>
      </main>

      <footer className="border-t border-outline-variant/20 py-6">
        <p className="text-center text-[11px] font-label uppercase tracking-widest text-on-surface-variant/70">
          Veritas Academia — Originality Grid 2.4
        </p>
      </footer>
    </div>
  );
}

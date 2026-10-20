import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import { requireUserForPage } from "@/lib/session";
import {
  getPublicInstructorProfile,
  formatMoney,
  formatTurnaround,
} from "@/lib/instructor-directory";

// Public instructor profile.
//
// Shadows the static Stitch screen at `/student/faculty/[id]` and renders the
// same design against real database fields only. There is no schema for
// ratings, reviews, testimonials, avatars, ORCID, lab affiliations or
// "top 1%" ranking, so none of those appear. A missing, suspended, unapproved
// or service-less instructor yields a 404 rather than leaking private state.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

export default async function InstructorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUserForPage("/student/find-faculty");
  const { id } = await params;
  const profile = await getPublicInstructorProfile(id);
  if (!profile) notFound();

  const primary = profile.services[0];
  const requestHref = primary
    ? `/student/new-service-request?service=${encodeURIComponent(primary.id)}`
    : "/student/find-faculty";

  return (
    <Shell
      persona="student"
      label={profile.name}
      group="find-faculty"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />
        <div className="pointer-events-none absolute top-72 -left-20 w-80 h-80 bg-secondary/10 rounded-full blur-3xl -z-10" />

        {/* Breadcrumb bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-6">
          <div className="flex items-center gap-3">
            <Link
              href="/student/find-faculty"
              className="group inline-flex items-center gap-2 px-3.5 py-1.5 rounded bg-surface-container-high hover:bg-surface-variant text-on-surface-variant hover:text-secondary transition-all duration-200 text-xs font-label uppercase tracking-wider"
            >
              <span className="material-symbols-outlined text-sm transition-transform group-hover:-translate-x-1">
                arrow_back
              </span>
              <span>Back to Directory</span>
            </Link>
            <span className="text-outline-variant text-xs">/</span>
            <div className="flex items-center gap-1.5 text-xs font-label">
              <span className="text-on-surface-variant">Find Instructors</span>
              <span className="text-outline-variant">/</span>
              <span className="text-secondary font-medium tracking-wide">{profile.name}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded bg-surface-container-high text-xs font-label">
            <span className="inline-block w-2 h-2 rounded-full bg-secondary shadow-[0_0_8px_#00ffcc]" />
            <span className="text-secondary font-semibold">Approved Instructor</span>
          </div>
        </div>

        {/* Hero profile header card */}
        <div className="relative w-full rounded-xl bg-surface-container p-7 md:p-8 overflow-hidden shadow-2xl">
          <div className="absolute -top-32 -right-24 w-96 h-96 rounded-full bg-primary/10 blur-[90px] pointer-events-none" />
          <div className="absolute -bottom-24 -left-20 w-80 h-80 rounded-full bg-secondary/10 blur-[80px] pointer-events-none" />
          <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-8">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 min-w-0">
              <div className="relative shrink-0">
                <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-xl bg-surface-container-highest border border-outline-variant/50 flex items-center justify-center shadow-[0_0_24px_rgba(0,255,204,0.18)]">
                  <span className="font-headline font-bold text-3xl text-primary">
                    {profile.name
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((part) => part[0]?.toUpperCase() ?? "")
                      .join("")}
                  </span>
                </div>
                <div className="absolute -bottom-2 -right-2 flex items-center gap-1.5 bg-surface-container-lowest px-2.5 py-1 rounded-full shadow-[0_0_12px_rgba(0,255,204,0.35)]">
                  <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
                  <span className="text-[10px] font-label font-bold text-secondary uppercase tracking-wider">
                    Available
                  </span>
                </div>
              </div>

              <div className="space-y-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-headline font-bold text-2xl sm:text-3xl tracking-tight text-on-surface">
                    {profile.name}
                  </h1>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-secondary-container/40 text-secondary text-[10px] font-label tracking-wider font-medium">
                    {profile.serviceCount} published service{profile.serviceCount === 1 ? "" : "s"}
                  </span>
                </div>
                {profile.headline ? (
                  <p className="font-body text-sm sm:text-base text-on-surface-variant font-medium">
                    {profile.headline}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3 text-xs font-label text-on-surface-variant pt-1">
                  <span className="flex items-center gap-1 text-secondary">
                    <span className="material-symbols-outlined text-sm">event_available</span>
                    Accepting service requests
                  </span>
                  {profile.fastestTurnaroundHours !== null ? (
                    <>
                      <span className="text-outline">•</span>
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">schedule</span>
                        {formatTurnaround(profile.fastestTurnaroundHours)}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0 self-stretch sm:self-auto justify-end">
              <Link
                href={requestHref}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-label font-semibold tracking-wider transition-all duration-150 shadow-[0_0_12px_rgba(255,45,120,0.25)]"
              >
                <span className="material-symbols-outlined text-base">upload_file</span>
                <span>Request Service</span>
              </Link>
            </div>
          </div>

          {/* Metrics row — real fields only */}
          <div className="mt-8 pt-6 grid grid-cols-2 lg:grid-cols-4 gap-4 bg-surface-container-low/70 rounded-lg p-4">
            <div className="flex items-center gap-3.5 p-2 rounded bg-surface-container/50">
              <div className="w-10 h-10 rounded bg-primary-container/30 flex items-center justify-center text-primary shrink-0 shadow-[0_0_10px_rgba(255,45,120,0.25)]">
                <span className="material-symbols-outlined text-xl">inventory_2</span>
              </div>
              <div>
                <div className="font-headline font-bold text-xl text-on-surface">{profile.serviceCount}</div>
                <p className="text-[11px] text-on-surface-variant truncate">Published services</p>
              </div>
            </div>

            <div className="flex items-center gap-3.5 p-2 rounded bg-surface-container/50">
              <div className="w-10 h-10 rounded bg-secondary-container/40 flex items-center justify-center text-secondary shrink-0 shadow-[0_0_10px_rgba(0,255,204,0.25)]">
                <span className="material-symbols-outlined text-xl">bolt</span>
              </div>
              <div>
                <div className="font-headline font-bold text-xl text-secondary">
                  {profile.fastestTurnaroundHours !== null ? formatTurnaround(profile.fastestTurnaroundHours) : "—"}
                </div>
                <p className="text-[11px] text-on-surface-variant truncate">Fastest turnaround</p>
              </div>
            </div>

            <div className="flex items-center gap-3.5 p-2 rounded bg-surface-container/50">
              <div className="w-10 h-10 rounded bg-tertiary-container/30 flex items-center justify-center text-tertiary shrink-0 shadow-[0_0_10px_rgba(255,224,74,0.25)]">
                <span className="material-symbols-outlined text-xl">payments</span>
              </div>
              <div>
                <div className="font-headline font-bold text-xl text-on-surface">
                  {profile.startingPriceMinor !== null
                    ? formatMoney(profile.startingPriceMinor, profile.currency)
                    : "—"}
                </div>
                <p className="text-[11px] text-on-surface-variant truncate">Starting price</p>
              </div>
            </div>

            <div className="flex items-center gap-3.5 p-2 rounded bg-surface-container/50">
              <div className="w-10 h-10 rounded bg-surface-variant flex items-center justify-center text-secondary shrink-0 shadow-[0_0_10px_rgba(0,255,204,0.15)]">
                <span className="material-symbols-outlined text-xl">event_available</span>
              </div>
              <div>
                <div className="font-headline font-bold text-xl text-secondary">Available</div>
                <p className="text-[11px] text-on-surface-variant truncate">Current status</p>
              </div>
            </div>
          </div>
        </div>

        {/* Main content grid */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-8 space-y-8 min-w-0">
            {/* About */}
            <div className="rounded-xl bg-surface-container p-6 sm:p-7 shadow-lg space-y-5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-xl">subject</span>
                <h2 className="font-headline font-bold text-lg text-on-surface">About the Instructor</h2>
              </div>

              {profile.bio ? (
                <p className="font-body text-sm leading-relaxed text-on-surface-variant">{profile.bio}</p>
              ) : (
                <p className="font-body text-sm leading-relaxed text-on-surface-variant">
                  This instructor has not added a biography yet. Their published services are listed below.
                </p>
              )}

              {profile.expertise.length > 0 ? (
                <div className="pt-2">
                  <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant/70 mb-2.5">
                    Methodological Specializations
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {profile.expertise.map((tag) => (
                      <span
                        key={tag}
                        className="px-3 py-1 rounded bg-surface-container-high text-secondary text-xs font-label"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {profile.qualifications.length > 0 ? (
                <div className="pt-2">
                  <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant/70 mb-2.5">
                    Qualifications
                  </div>
                  <ul className="space-y-1.5">
                    {profile.qualifications.map((qualification) => (
                      <li
                        key={qualification}
                        className="flex items-start gap-2 text-xs font-body text-on-surface-variant"
                      >
                        <span className="material-symbols-outlined text-sm text-secondary mt-0.5">check_circle</span>
                        <span>{qualification}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* Services */}
            <div className="rounded-xl bg-surface-container p-6 sm:p-7 shadow-lg space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-xl">inventory_2</span>
                  <h2 className="font-headline font-bold text-lg text-on-surface">Academic Support Services</h2>
                </div>
                <span className="px-2.5 py-1 rounded bg-surface-variant text-[11px] font-label text-on-surface-variant">
                  {profile.serviceCount} Active Service Module{profile.serviceCount === 1 ? "" : "s"}
                </span>
              </div>

              <div className="space-y-4">
                {profile.services.map((service) => (
                  <div
                    key={service.id}
                    className="p-5 rounded-lg bg-surface-container-high transition-all duration-200"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                      <div className="space-y-1.5 flex-1 min-w-0">
                        <h3 className="font-headline font-bold text-sm sm:text-base text-on-surface">
                          {service.name}
                        </h3>
                        {service.description ? (
                          <p className="text-xs text-on-surface-variant">{service.description}</p>
                        ) : null}
                      </div>
                      <div className="sm:text-right shrink-0 pl-6 sm:pl-0">
                        <div className="flex items-baseline sm:justify-end gap-1">
                          <span className="font-headline font-bold text-2xl text-primary">
                            {formatMoney(service.amountMinor, service.currency)}
                          </span>
                        </div>
                        <span className="inline-flex items-center gap-1 text-[11px] font-label text-secondary mt-1">
                          <span className="material-symbols-outlined text-xs">timer</span>
                          {formatTurnaround(service.turnaroundHours)}
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 pt-3.5 border-t border-outline-variant/20 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-label text-on-surface-variant">
                        Reference code: <span className="font-mono text-on-surface">{service.code}</span>
                      </span>
                      <Link
                        href={`/student/new-service-request?service=${encodeURIComponent(service.id)}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-variant border border-secondary/40 hover:border-secondary text-[11px] font-label text-secondary transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm">arrow_forward</span>
                        Request this service
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right / secondary column */}
          <div className="lg:col-span-4 lg:sticky lg:top-20 space-y-6">
            <div className="rounded-xl bg-surface-container p-6 sm:p-7 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary shadow-[0_0_12px_#ff2d78]" />
              <div className="flex items-center justify-between pb-4 border-b border-outline-variant/30">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-secondary shadow-[0_0_8px_#00ffcc]" />
                  <span className="font-label text-xs uppercase tracking-widest text-on-surface font-bold">
                    Service Dispatch
                  </span>
                </div>
                <span className="text-[10px] font-label text-secondary uppercase bg-secondary-container/40 px-2 py-0.5 rounded">
                  Active Queue
                </span>
              </div>

              <div className="py-5 space-y-2">
                <div className="text-[11px] font-label text-on-surface-variant uppercase tracking-wider">
                  Published services
                </div>
                <ul className="space-y-2">
                  {profile.services.map((service) => (
                    <li
                      key={service.id}
                      className="flex items-center justify-between gap-2 text-xs font-body text-on-surface-variant"
                    >
                      <span className="truncate">{service.name}</span>
                      <span className="font-headline font-semibold text-on-surface shrink-0">
                        {formatMoney(service.amountMinor, service.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pt-2 border-t border-outline-variant/30 space-y-3">
                <div className="p-3 rounded bg-surface-container-low flex items-start gap-2.5 text-xs text-on-surface-variant">
                  <span className="material-symbols-outlined text-secondary text-base shrink-0 mt-0.5">info</span>
                  <span className="leading-relaxed font-body text-[11px]">
                    Next step: you will upload your draft and specify citation verification rules on the
                    service request screen.
                  </span>
                </div>

                <Link
                  href={requestHref}
                  className="w-full py-3.5 px-4 rounded bg-gradient-to-r from-primary to-primary-container hover:from-primary-fixed-dim hover:to-primary text-on-primary font-headline font-bold text-xs uppercase tracking-wider transition-all duration-200 shadow-[0_0_20px_rgba(255,45,120,0.4)] flex items-center justify-center gap-2"
                >
                  <span>Request Service &amp; Continue to Upload</span>
                  <span className="material-symbols-outlined text-base">arrow_forward</span>
                </Link>
              </div>
            </div>

            <div className="rounded-xl bg-surface-container p-5 shadow-lg space-y-2 text-[11px] font-label text-on-surface-variant">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-sm">lock</span>
                <span>Private document vault storage</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-sm">shield</span>
                <span>Instructor access is role-checked per request</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

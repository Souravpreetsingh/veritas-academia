import Link from "next/link";
import Shell from "@/components/Shell";
import { requireUserForPage } from "@/lib/session";
import {
  DIRECTORY_SORTS,
  listInstructors,
  parseDirectoryQuery,
  formatMoney,
  formatTurnaround,
  type DirectoryInstructor,
  type DirectorySort,
} from "@/lib/instructor-directory";

// Live instructor directory.
//
// This shadows the static Stitch screen at `/student/find-faculty` and renders
// the same design against real database rows. Only fields that exist in the
// schema are shown (name, headline, expertise, published services, price,
// turnaround, availability). Ratings, reviews, cohort counts, badges and
// testimonials are deliberately absent because there is no data for them.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

const SORT_LABELS: Record<DirectorySort, string> = {
  name_asc: "Name (A–Z)",
  name_desc: "Name (Z–A)",
  newest: "Recently added",
};

type RawParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Price inputs are collected in major currency units; the query layer works in
// minor units. Unparseable input is forwarded verbatim so the shared validator
// rejects it with a single consistent error path.
function toMinorUnits(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return raw;
  return String(Math.round(parsed * 100));
}

function buildHref(params: RawParams, page: number): string {
  const sp = new URLSearchParams();
  for (const key of ["q", "minPrice", "maxPrice", "sort"] as const) {
    const value = firstValue(params[key]);
    if (value && value.trim() !== "") sp.set(key, value.trim());
  }
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/student/find-faculty?${qs}` : "/student/find-faculty";
}

function pageWindow(current: number, total: number): number[] {
  const start = Math.max(1, Math.min(current - 2, total - 4));
  const end = Math.min(total, start + 4);
  const pages: number[] = [];
  for (let p = start; p <= end; p += 1) pages.push(p);
  return pages;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function MetricCell({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon: string;
  accent: "primary" | "secondary" | "tertiary" | "muted";
}) {
  const iconTone =
    accent === "primary"
      ? "text-primary"
      : accent === "secondary"
        ? "text-secondary"
        : accent === "tertiary"
          ? "text-tertiary"
          : "text-on-surface-variant";
  return (
    <div className="p-2.5 rounded bg-surface-container-low border border-outline-variant/30 flex flex-col justify-between">
      <span className="text-[10px] font-label uppercase tracking-wider text-on-surface-variant/80">
        {label}
      </span>
      <div className="flex items-center gap-1.5 mt-1">
        <span className={`material-symbols-outlined text-sm ${iconTone}`}>{icon}</span>
        <span className="text-xs font-headline font-semibold text-on-surface truncate">{value}</span>
      </div>
    </div>
  );
}

function InstructorCard({ instructor, accent }: { instructor: DirectoryInstructor; accent: "primary" | "secondary" }) {
  const hoverBorder = accent === "primary" ? "hover:border-primary/50" : "hover:border-secondary/50";
  const hoverShadow =
    accent === "primary"
      ? "hover:shadow-[0_0_24px_rgba(255,45,120,0.18)]"
      : "hover:shadow-[0_0_24px_rgba(0,255,204,0.18)]";
  const linkTone = accent === "primary" ? "text-primary" : "text-secondary";

  return (
    <div
      className={`group relative rounded-xl bg-surface-container/70 hover:bg-surface-container border border-outline-variant/35 ${hoverBorder} transition-all duration-300 p-5 flex flex-col justify-between ${hoverShadow} hover:-translate-y-0.5`}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3.5">
          <div className="relative shrink-0">
            <div className="w-[52px] h-[52px] rounded-lg bg-surface-container-highest border border-outline-variant/60 flex items-center justify-center">
              <span className="font-headline font-bold text-lg text-primary">{initialsOf(instructor.name)}</span>
            </div>
            <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-surface-container border-2 border-surface flex items-center justify-center">
              <span className="w-2 h-2 rounded-full bg-secondary shadow-[0_0_6px_#00ffcc]" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <h3 className="font-headline font-bold text-sm text-on-surface truncate">{instructor.name}</h3>
              <span className="text-[10px] font-label text-secondary bg-secondary/10 px-1.5 py-0.5 rounded border border-secondary/20 shrink-0">
                Available
              </span>
            </div>
            <p className="text-xs font-body text-on-surface-variant truncate mt-0.5">
              {instructor.headline ?? "Instructor"}
            </p>
          </div>
        </div>

        {instructor.expertise.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {instructor.expertise.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded bg-surface-container-high text-[10px] font-label text-on-surface-variant truncate max-w-[140px]"
              >
                {tag}
              </span>
            ))}
            {instructor.expertise.length > 3 ? (
              <span className="px-2 py-0.5 rounded bg-surface-container-high text-[10px] font-label text-on-surface-variant/70">
                +{instructor.expertise.length - 3}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <MetricCell
            label="Availability"
            value={instructor.available ? "Available" : "Unavailable"}
            icon="event_available"
            accent="secondary"
          />
          <MetricCell
            label="Fastest Turnaround"
            value={instructor.fastestTurnaroundHours !== null ? formatTurnaround(instructor.fastestTurnaroundHours) : "—"}
            icon="schedule"
            accent="secondary"
          />
          <MetricCell
            label="Starting Price"
            value={
              instructor.startingPriceMinor !== null
                ? `${formatMoney(instructor.startingPriceMinor, instructor.currency)}+`
                : "—"
            }
            icon="payments"
            accent="primary"
          />
          <MetricCell
            label="Published Services"
            value={`${instructor.serviceCount} service${instructor.serviceCount === 1 ? "" : "s"}`}
            icon="inventory_2"
            accent="muted"
          />
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-outline-variant/30 flex items-center justify-between text-xs font-headline">
        <span className="text-[11px] font-label text-on-surface-variant">
          {instructor.serviceCount} published service{instructor.serviceCount === 1 ? "" : "s"}
        </span>
        <Link
          href={`/student/faculty/${instructor.id}`}
          className={`${linkTone} group-hover:translate-x-1 transition-transform flex items-center gap-1 font-semibold text-xs`}
        >
          View Profile &amp; Request Review
          <span className="material-symbols-outlined text-sm">arrow_forward</span>
        </Link>
      </div>
    </div>
  );
}

export default async function FindFacultyPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const user = await requireUserForPage("/student/find-faculty");
  const params = await searchParams;

  const parsed = parseDirectoryQuery({
    q: firstValue(params.q),
    page: firstValue(params.page),
    pageSize: firstValue(params.pageSize),
    minPrice: toMinorUnits(firstValue(params.minPrice)),
    maxPrice: toMinorUnits(firstValue(params.maxPrice)),
    sort: firstValue(params.sort),
  });

  if (!parsed.ok) {
    return (
      <Shell
        persona="student"
        label="Find Faculty & Instructors"
        group="find-faculty"
        user={{ name: user.name, role: user.role }}
        mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
      >
        <div className="rounded-xl bg-surface-container/70 border border-error/40 p-6 space-y-3">
          <div className="flex items-center gap-2 text-error font-headline text-sm font-semibold">
            <span className="material-symbols-outlined text-base">error</span>
            Invalid search parameters
          </div>
          <ul className="space-y-1 text-xs font-body text-on-surface-variant">
            {parsed.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
          <Link
            href="/student/find-faculty"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-variant border border-outline-variant/60 hover:border-secondary text-xs font-label text-on-surface transition-colors"
          >
            <span className="material-symbols-outlined text-sm">restart_alt</span>
            Reset search
          </Link>
        </div>
      </Shell>
    );
  }

  const query = parsed.value;
  const result = await listInstructors(query);

  const activeTags: { label: string; href: string }[] = [];
  if (query.q) activeTags.push({ label: `Search: ${query.q}`, href: buildHref({ ...params, q: "" }, 1) });
  if (query.minPriceMinor !== null)
    activeTags.push({
      label: `Min: ${formatMoney(query.minPriceMinor, "INR")}`,
      href: buildHref({ ...params, minPrice: "" }, 1),
    });
  if (query.maxPriceMinor !== null)
    activeTags.push({
      label: `Max: ${formatMoney(query.maxPriceMinor, "INR")}`,
      href: buildHref({ ...params, maxPrice: "" }, 1),
    });

  const rangeStart = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const rangeEnd = Math.min(result.total, result.page * result.pageSize);

  return (
    <Shell
      persona="student"
      label="Find Faculty & Instructors"
      group="find-faculty"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />
        <div className="pointer-events-none absolute top-72 -left-20 w-80 h-80 bg-secondary/10 rounded-full blur-3xl -z-10" />

        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6">
          <div className="space-y-1.5 max-w-2xl">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface-container-high border border-outline-variant/50 text-[10px] font-label tracking-widest text-secondary uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary shadow-[0_0_6px_#00ffcc]" />
                Peer Verification Matrix
              </span>
            </div>
            <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
              Find your instructor
            </h1>
            <p className="text-sm font-body text-on-surface-variant">
              Compare approved instructors and secure specialized peer evaluations for academic
              submissions and manuscript audits.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0 px-3 py-1.5 rounded bg-surface-container border border-outline-variant/40 shadow-inner">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-secondary" />
            </span>
            <span className="text-xs font-headline font-semibold text-on-surface">
              {result.total} instructor{result.total === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] font-label text-on-surface-variant">listed</span>
          </div>
        </div>

        <form
          method="get"
          action="/student/find-faculty"
          className="bg-surface-container/85 backdrop-blur-md rounded-xl p-3 border border-outline-variant/40 shadow-xl mb-8 space-y-3"
        >
          <div className="flex flex-col 2xl:flex-row gap-3">
            <div className="relative flex-1">
              <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">
                manage_search
              </span>
              <input
                name="q"
                defaultValue={query.q}
                maxLength={80}
                className="w-full bg-surface-container-low border border-outline-variant/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface placeholder:text-on-surface-variant/50 text-xs rounded-lg pl-10 pr-4 py-2.5 outline-none font-body transition-all"
                placeholder="Search by instructor name, headline, expertise, or service..."
                type="text"
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 2xl:flex items-center gap-2">
              <input
                name="minPrice"
                defaultValue={firstValue(params.minPrice) ?? ""}
                min={0}
                className="w-full 2xl:w-36 bg-surface-container-low border border-outline-variant/50 hover:border-secondary/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface placeholder:text-on-surface-variant/50 text-xs rounded-lg px-3 py-2.5 outline-none font-body transition-colors"
                placeholder="Min price"
                type="number"
              />
              <input
                name="maxPrice"
                defaultValue={firstValue(params.maxPrice) ?? ""}
                min={0}
                className="w-full 2xl:w-36 bg-surface-container-low border border-outline-variant/50 hover:border-secondary/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface placeholder:text-on-surface-variant/50 text-xs rounded-lg px-3 py-2.5 outline-none font-body transition-colors"
                placeholder="Max price"
                type="number"
              />
              <select
                name="sort"
                defaultValue={query.sort}
                className="w-full 2xl:w-48 bg-surface-container-low border border-outline-variant/50 hover:border-secondary/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface text-xs rounded-lg px-3 py-2.5 outline-none font-label transition-colors appearance-none cursor-pointer"
              >
                {DIRECTORY_SORTS.map((sort) => (
                  <option key={sort} value={sort}>
                    {SORT_LABELS[sort]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="w-full 2xl:w-auto px-5 py-2.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold tracking-wide transition-all duration-150 flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-sm">search</span>
                Search
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-outline-variant/20 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-label text-on-surface-variant/80 uppercase tracking-wider">
                Active criteria:
              </span>
              {activeTags.length === 0 ? (
                <span className="text-[11px] font-label text-on-surface-variant/60">None</span>
              ) : (
                activeTags.map((tag) => (
                  <span
                    key={tag.label}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-variant/80 text-[11px] font-label text-on-surface border border-secondary/30"
                  >
                    <span>{tag.label}</span>
                    <Link href={tag.href} aria-label={`Remove ${tag.label}`} className="hover:text-primary transition-colors leading-none">
                      ×
                    </Link>
                  </span>
                ))
              )}
            </div>
            <Link
              href="/student/find-faculty"
              className="inline-flex items-center gap-1.5 text-xs font-label text-on-surface-variant hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-sm">restart_alt</span>
              <span>Clear all filters</span>
            </Link>
          </div>
        </form>

        {result.instructors.length === 0 ? (
          <div className="p-6 rounded-xl bg-surface-container/40 border border-outline-variant/25 text-center space-y-3">
            <div className="flex items-center justify-center gap-2 text-primary font-headline text-sm font-semibold">
              <span className="material-symbols-outlined text-base">filter_list_off</span>
              No instructors found
            </div>
            <p className="text-xs font-body text-on-surface-variant">
              Approved instructors with at least one published service will appear here. Try broadening
              your search or clearing the filters.
            </p>
            <Link
              href="/student/find-faculty"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-variant border border-outline-variant/60 hover:border-primary text-xs font-label text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-sm">restart_alt</span>
              Reset all criteria
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {result.instructors.map((instructor, index) => (
              <InstructorCard
                key={instructor.id}
                instructor={instructor}
                accent={index % 2 === 0 ? "primary" : "secondary"}
              />
            ))}
          </div>
        )}

        {result.totalPages > 1 ? (
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl bg-surface-container/50 border border-outline-variant/30">
            <div className="flex items-center gap-2 text-xs font-label text-on-surface-variant">
              <span>
                Showing <strong className="text-on-surface">{rangeStart} - {rangeEnd}</strong> of{" "}
                <strong className="text-on-surface">{result.total}</strong> instructors
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {result.page > 1 ? (
                <Link
                  href={buildHref(params, result.page - 1)}
                  aria-label="Previous page"
                  className="p-2 rounded bg-surface-container-low border border-outline-variant/40 hover:border-secondary text-on-surface-variant hover:text-secondary transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">chevron_left</span>
                </Link>
              ) : (
                <span className="p-2 rounded bg-surface-container-low border border-outline-variant/30 text-on-surface-variant/40 cursor-not-allowed">
                  <span className="material-symbols-outlined text-sm">chevron_left</span>
                </span>
              )}
              {pageWindow(result.page, result.totalPages).map((page) =>
                page === result.page ? (
                  <span
                    key={page}
                    className="w-8 h-8 rounded bg-surface-variant border border-primary text-primary text-xs font-headline font-semibold shadow-[0_0_8px_rgba(255,45,120,0.3)] flex items-center justify-center"
                  >
                    {page}
                  </span>
                ) : (
                  <Link
                    key={page}
                    href={buildHref(params, page)}
                    className="w-8 h-8 rounded bg-surface-container-low border border-outline-variant/40 hover:border-outline text-on-surface-variant text-xs font-headline transition-colors flex items-center justify-center"
                  >
                    {page}
                  </Link>
                ),
              )}
              {result.page < result.totalPages ? (
                <Link
                  href={buildHref(params, result.page + 1)}
                  aria-label="Next page"
                  className="p-2 rounded bg-surface-container-low border border-outline-variant/40 hover:border-secondary text-on-surface-variant hover:text-secondary transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">chevron_right</span>
                </Link>
              ) : (
                <span className="p-2 rounded bg-surface-container-low border border-outline-variant/30 text-on-surface-variant/40 cursor-not-allowed">
                  <span className="material-symbols-outlined text-sm">chevron_right</span>
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

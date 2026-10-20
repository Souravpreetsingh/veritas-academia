import Link from "next/link";
import Shell from "@/components/Shell";
import ServiceRequestForm from "@/components/ServiceRequestForm";
import { requireUserForPage } from "@/lib/session";
import { getRequestableService, listInstructors, formatMoney, formatTurnaround } from "@/lib/instructor-directory";

// New Service Request (wizard steps 01–02).
//
// Shadows the static Stitch screen at `/student/new-service-request`. When a
// service is chosen (`?service=<id>`, linked from the instructor profile), the
// live form is shown; otherwise the student picks a service from real, eligible
// instructors. The price shown is the real service price; the server remains
// authoritative at creation time.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

type RawParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewServiceRequestPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const user = await requireUserForPage("/student/new-service-request");
  const params = await searchParams;
  const serviceId = firstValue(params.service);
  const requestable = serviceId ? await getRequestableService(serviceId) : null;

  return (
    <Shell
      persona="student"
      label="New Service Request"
      group="new-service-request"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12 max-w-5xl">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />
        <div className="pointer-events-none absolute top-72 -left-20 w-80 h-80 bg-secondary/10 rounded-full blur-3xl -z-10" />

        <div className="pb-6 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-label text-on-surface-variant">
            <Link href="/student/find-faculty" className="hover:text-secondary transition-colors">
              Find Instructors
            </Link>
            <span className="text-outline-variant">/</span>
            <span className="text-on-surface font-medium">New Service Request</span>
          </div>
          <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
            Commission a service request
          </h1>
          <p className="text-sm font-body text-on-surface-variant">
            Select an approved instructor&apos;s published service, describe your requirements and
            review the calculated total before dispatch.
          </p>
        </div>

        {requestable ? (
          <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 sm:p-7 shadow-xl">
            <ServiceRequestForm
              instructorId={requestable.instructorId}
              instructorName={requestable.instructorName}
              instructorHeadline={requestable.instructorHeadline}
              selectedServiceId={requestable.serviceId}
              services={requestable.services.map((s) => ({
                id: s.id,
                code: s.code,
                name: s.name,
                amountMinor: s.amountMinor,
                currency: s.currency,
                turnaroundHours: s.turnaroundHours,
              }))}
            />
          </div>
        ) : (
          <ServicePicker selected={serviceId} />
        )}
      </div>
    </Shell>
  );
}

async function ServicePicker({ selected }: { selected?: string }) {
  const result = await listInstructors({
    q: "",
    minPriceMinor: null,
    maxPriceMinor: null,
    page: 1,
    pageSize: 12,
    sort: "name_asc",
  });

  return (
    <div className="space-y-6">
      {selected ? (
        <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-tertiary-container/20 border border-tertiary/30 text-xs text-on-surface">
          <span className="material-symbols-outlined text-tertiary text-base shrink-0">info</span>
          <span>
            That service is no longer available. Choose an approved instructor&apos;s service below.
          </span>
        </div>
      ) : null}

      {result.instructors.length === 0 ? (
        <div className="rounded-xl bg-surface-container/50 border border-outline-variant/30 p-6 text-center space-y-3">
          <div className="flex items-center justify-center gap-2 text-primary font-headline text-sm font-semibold">
            <span className="material-symbols-outlined text-base">school</span>
            No instructors available
          </div>
          <p className="text-xs font-body text-on-surface-variant">
            Once approved instructors publish services, you&apos;ll be able to commission them here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {result.instructors.map((instructor) => (
            <div
              key={instructor.id}
              className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-5 space-y-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-headline font-bold text-sm text-on-surface truncate">
                    {instructor.name}
                  </h2>
                  {instructor.headline ? (
                    <p className="text-xs font-body text-on-surface-variant truncate">
                      {instructor.headline}
                    </p>
                  ) : null}
                </div>
                <Link
                  href={`/student/faculty/${instructor.id}`}
                  className="shrink-0 text-[11px] font-label text-secondary hover:text-primary transition-colors"
                >
                  View profile →
                </Link>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {instructor.services.map((service) => (
                  <Link
                    key={service.id}
                    href={`/student/new-service-request?service=${encodeURIComponent(service.id)}`}
                    className="group flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-container-high hover:bg-surface-variant border border-outline-variant/40 hover:border-secondary/50 transition-all"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-headline font-semibold text-on-surface truncate">
                        {service.name}
                      </div>
                      <div className="text-[11px] font-label text-on-surface-variant flex items-center gap-1">
                        <span className="material-symbols-outlined text-[12px]">timer</span>
                        {formatTurnaround(service.turnaroundHours)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-headline font-bold text-sm text-primary">
                        {formatMoney(service.amountMinor, service.currency)}
                      </div>
                      <span className="text-[10px] font-label text-secondary group-hover:translate-x-0.5 inline-block transition-transform">
                        Select →
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

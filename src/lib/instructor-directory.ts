import { prisma } from "@/lib/db";
import { evaluateInstructorEligibility } from "@/lib/instructor-eligibility";
import type { Role } from "@/lib/domain";

// ---------------------------------------------------------------------------
// Public instructor directory + public instructor profile.
//
// Visibility is decided entirely on the server using the existing
// instructor-eligibility rule; a client can never widen it. Only fields that
// genuinely exist in the database are exposed, so ratings, reviews, student
// counts, badges and testimonials are deliberately absent (there is no schema
// for them, and fabricating them would be wrong).
//
// Kept free of `server-only` so the node:test suites can import it directly.
// ---------------------------------------------------------------------------

export const DIRECTORY_PAGE_SIZE_DEFAULT = 12;
export const DIRECTORY_PAGE_SIZE_MAX = 24;
export const DIRECTORY_MAX_PRICE_MINOR = 50_000_000;
export const DIRECTORY_MAX_QUERY_LENGTH = 80;

export const DIRECTORY_SORTS = ["name_asc", "name_desc", "newest"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

function isDirectorySort(value: unknown): value is DirectorySort {
  return typeof value === "string" && (DIRECTORY_SORTS as readonly string[]).includes(value);
}

export interface DirectoryQuery {
  q: string;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  page: number;
  pageSize: number;
  sort: DirectorySort;
}

export type ParsedDirectoryQuery =
  | { ok: true; value: DirectoryQuery }
  | { ok: false; errors: string[] };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Remove control characters so a crafted string cannot break the query UI. */
function stripControl(value: string): string {
  return Array.from(value)
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("");
}

/** Parse minor-unit money. Rejects anything that is not a clean integer in range. */
function parseMinorUnits(raw: string | undefined, field: string, errors: string[]): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > DIRECTORY_MAX_PRICE_MINOR) {
    errors.push(`${field} must be a whole number between 0 and ${DIRECTORY_MAX_PRICE_MINOR}.`);
    return null;
  }
  return value;
}

/**
 * Server-side validation of every user-controlled directory parameter.
 * Invalid input is rejected (never silently coerced) so a crafted query can
 * never bypass approval, visibility or pagination limits.
 */
export function parseDirectoryQuery(
  input: Record<string, string | string[] | undefined>,
): ParsedDirectoryQuery {
  const errors: string[] = [];

  const rawQuery = first(input.q);
  let q = "";
  if (rawQuery !== undefined && rawQuery.trim() !== "") {
    q = stripControl(rawQuery).trim();
    if (q.length > DIRECTORY_MAX_QUERY_LENGTH) {
      errors.push(`Search must be ${DIRECTORY_MAX_QUERY_LENGTH} characters or fewer.`);
    }
  }

  const rawPage = first(input.page);
  let page = 1;
  if (rawPage !== undefined && rawPage.trim() !== "") {
    const parsed = Number(rawPage);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push("Page must be a whole number of 1 or more.");
    } else {
      page = parsed;
    }
  }

  const rawSize = first(input.pageSize);
  let pageSize = DIRECTORY_PAGE_SIZE_DEFAULT;
  if (rawSize !== undefined && rawSize.trim() !== "") {
    const parsed = Number(rawSize);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > DIRECTORY_PAGE_SIZE_MAX) {
      errors.push(`Page size must be between 1 and ${DIRECTORY_PAGE_SIZE_MAX}.`);
    } else {
      pageSize = parsed;
    }
  }

  const minPriceMinor = parseMinorUnits(first(input.minPrice), "Minimum price", errors);
  const maxPriceMinor = parseMinorUnits(first(input.maxPrice), "Maximum price", errors);
  if (minPriceMinor !== null && maxPriceMinor !== null && minPriceMinor > maxPriceMinor) {
    errors.push("Minimum price cannot be greater than maximum price.");
  }

  const rawSort = first(input.sort);
  let sort: DirectorySort = "name_asc";
  if (rawSort !== undefined && rawSort.trim() !== "" && !isDirectorySort(rawSort)) {
    errors.push("Unknown sort option.");
  } else if (isDirectorySort(rawSort)) {
    sort = rawSort;
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { q, minPriceMinor, maxPriceMinor, page, pageSize, sort } };
}

export interface PublicInstructorService {
  id: string;
  code: string;
  name: string;
  description: string | null;
  amountMinor: number;
  currency: string;
  turnaroundHours: number;
}

export interface DirectoryInstructor {
  /** Public handle: the InstructorProfile id. Never an email or a user id. */
  id: string;
  name: string;
  headline: string | null;
  expertise: string[];
  services: PublicInstructorService[];
  serviceCount: number;
  startingPriceMinor: number | null;
  currency: string;
  fastestTurnaroundHours: number | null;
  available: boolean;
}

export interface DirectoryResult {
  instructors: DirectoryInstructor[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Expertise / qualifications are stored as JSON-encoded string arrays. */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
}

type ServiceRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  amountMinor: number;
  currency: string;
  turnaroundHours: number;
};

/** Reduce an instructor's published services to the facts we can honestly show. */
export function summarizeServices(services: ServiceRow[]) {
  if (services.length === 0) {
    return {
      services: [] as PublicInstructorService[],
      serviceCount: 0,
      startingPriceMinor: null as number | null,
      currency: "INR",
      fastestTurnaroundHours: null as number | null,
    };
  }

  const cheapest = services.reduce((best, s) => (s.amountMinor < best.amountMinor ? s : best));
  const fastest = services.reduce((best, s) => (s.turnaroundHours < best.turnaroundHours ? s : best));

  return {
    services,
    serviceCount: services.length,
    startingPriceMinor: cheapest.amountMinor,
    currency: cheapest.currency,
    fastestTurnaroundHours: fastest.turnaroundHours,
  };
}

function buildWhere(query: DirectoryQuery) {
  const amountFilter: Record<string, number> = {};
  if (query.minPriceMinor !== null) amountFilter.gte = query.minPriceMinor;
  if (query.maxPriceMinor !== null) amountFilter.lte = query.maxPriceMinor;

  const conditions: Record<string, unknown>[] = [
    { role: "INSTRUCTOR" },
    { suspended: false },
    {
      instructorProfile: {
        isApproved: true,
        isActive: true,
        services: {
          some: {
            isActive: true,
            ...(Object.keys(amountFilter).length > 0 ? { amountMinor: amountFilter } : {}),
          },
        },
      },
    },
  ];

  if (query.q) {
    const needle = query.q;
    conditions.push({
      OR: [
        { name: { contains: needle } },
        { instructorProfile: { headline: { contains: needle } } },
        { instructorProfile: { expertise: { contains: needle } } },
        { instructorProfile: { qualifications: { contains: needle } } },
        { instructorProfile: { services: { some: { name: { contains: needle } } } } },
        { instructorProfile: { services: { some: { description: { contains: needle } } } } },
      ],
    });
  }

  return { AND: conditions };
}

const orderByFor = (sort: DirectorySort) => {
  switch (sort) {
    case "name_desc":
      return { name: "desc" as const };
    case "newest":
      return { createdAt: "desc" as const };
    case "name_asc":
    default:
      return { name: "asc" as const };
  }
};

/**
 * One page of publicly visible instructors. Every row is re-checked against
 * the eligibility rule after the query so a database anomaly can never leak an
 * unapproved, suspended or service-less instructor into the directory.
 */
export async function listInstructors(query: DirectoryQuery): Promise<DirectoryResult> {
  const where = buildWhere(query);

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: orderByFor(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        instructorProfile: {
          include: { services: { where: { isActive: true }, orderBy: { amountMinor: "asc" } } },
        },
      },
    }),
  ]);

  const instructors: DirectoryInstructor[] = [];

  for (const user of users) {
    const profile = user.instructorProfile;
    if (!profile) continue;

    const eligible = evaluateInstructorEligibility({
      role: user.role as Role,
      suspended: user.suspended,
      profile: { isApproved: profile.isApproved, isActive: profile.isActive },
    });
    if (!eligible.eligible) continue;

    const summary = summarizeServices(profile.services);
    if (summary.serviceCount === 0) continue;

    instructors.push({
      id: profile.id,
      name: user.name,
      headline: profile.headline,
      expertise: parseStringArray(profile.expertise),
      ...summary,
      available: profile.isActive && !user.suspended,
    });
  }

  return {
    instructors,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
  };
}

export interface PublicInstructorProfile {
  id: string;
  name: string;
  headline: string | null;
  bio: string | null;
  expertise: string[];
  qualifications: string[];
  services: PublicInstructorService[];
  serviceCount: number;
  startingPriceMinor: number | null;
  currency: string;
  fastestTurnaroundHours: number | null;
}

/**
 * A single instructor's public profile.
 *
 * Returns `null` — which the route turns into a 404 — for a missing, suspended,
 * unapproved or service-less instructor, so a private application is never
 * discoverable by guessing an id. The returned object is built from an explicit
 * whitelist: email, suspension state, application review notes and personal
 * documents can never appear in a public response.
 */
export async function getPublicInstructorProfile(
  id: unknown,
): Promise<PublicInstructorProfile | null> {
  if (typeof id !== "string" || id.trim() === "" || id.length > 64) return null;

  const profile = await prisma.instructorProfile.findUnique({
    where: { id },
    include: {
      user: true,
      services: { where: { isActive: true }, orderBy: { amountMinor: "asc" } },
    },
  });
  if (!profile) return null;

  const { user } = profile;
  const eligible = evaluateInstructorEligibility({
    role: user.role as Role,
    suspended: user.suspended,
    profile: { isApproved: profile.isApproved, isActive: profile.isActive },
  });
  if (!eligible.eligible) return null;

  const summary = summarizeServices(profile.services);
  if (summary.serviceCount === 0) return null;

  return {
    id: profile.id,
    name: user.name,
    headline: profile.headline,
    bio: profile.bio,
    expertise: parseStringArray(profile.expertise),
    qualifications: parseStringArray(profile.qualifications),
    ...summary,
  };
}

export interface RequestableService {
  serviceId: string;
  serviceName: string;
  serviceCode: string;
  serviceDescription: string | null;
  amountMinor: number;
  currency: string;
  turnaroundHours: number;
  instructorId: string;
  instructorName: string;
  instructorHeadline: string | null;
  /** The instructor's other active services, so the student can switch. */
  services: PublicInstructorService[];
}

/**
 * Resolve a single requestable service (by id) together with its instructor,
 * for the "New Service Request" wizard.
 *
 * Returns `null` — the page then 404s — for a missing, inactive, or
 * not-currently-eligible instructor/service, so a student can never open the
 * wizard against an instructor the server would refuse at creation time.
 */
export async function getRequestableService(
  serviceId: unknown,
): Promise<RequestableService | null> {
  if (typeof serviceId !== "string" || serviceId.trim() === "" || serviceId.length > 64) {
    return null;
  }

  const service = await prisma.instructorService.findUnique({
    where: { id: serviceId },
    include: {
      instructor: {
        include: {
          user: true,
          services: { where: { isActive: true }, orderBy: { amountMinor: "asc" } },
        },
      },
    },
  });
  if (!service || !service.isActive) return null;

  const { instructor } = service;
  const eligible = evaluateInstructorEligibility({
    role: instructor.user.role as Role,
    suspended: instructor.user.suspended,
    profile: { isApproved: instructor.isApproved, isActive: instructor.isActive },
  });
  if (!eligible.eligible) return null;

  return {
    serviceId: service.id,
    serviceName: service.name,
    serviceCode: service.code,
    serviceDescription: service.description,
    amountMinor: service.amountMinor,
    currency: service.currency,
    turnaroundHours: service.turnaroundHours,
    instructorId: instructor.id,
    instructorName: instructor.user.name,
    instructorHeadline: instructor.headline,
    services: instructor.services.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      description: s.description,
      amountMinor: s.amountMinor,
      currency: s.currency,
      turnaroundHours: s.turnaroundHours,
    })),
  };
}

// ---------------------------------------------------------------------------
// Display helpers live in @/lib/format (client-safe) and are re-exported here
// for backwards compatibility with existing imports.
// ---------------------------------------------------------------------------

export { formatMoney, formatTurnaround } from "@/lib/format";

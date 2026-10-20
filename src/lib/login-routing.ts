import { homePathForRole, type Role } from "@/lib/domain";

// Post-login routing is a security decision, so it is kept pure and testable.
//
// Rules:
//   - A return URL ("next") is only honoured when it is a same-origin relative
//     path AND the verified role is allowed to reach that area. A client can
//     never widen its own access by supplying `next`.
//   - Otherwise the user is sent to the dashboard for their VERIFIED role.
//
// The role passed here must come from the server (the database / session), never
// from client input.

export type Portal = "student" | "instructor";

/**
 * True when a verified role may sign in through the given portal. Admins may
 * use both portals for support. A pending instructor applicant is still a
 * STUDENT and must use the student sign-in, but the instructor onboarding
 * status page (not the student dashboard) explains their application state.
 */
export function canUsePortal(portal: Portal, role: Role): boolean {
  if (role === "ADMIN") return true;
  return portal === "student" ? role === "STUDENT" : role === "INSTRUCTOR";
}

/**
 * A signed-in user is only redirected away from a login screen for their own
 * portal. A session in the other role must not block the form: the page stays
 * reachable so the visitor can sign out or switch accounts. Returns the
 * redirect path, or null when the login screen should render.
 */
export function resolveLoginScreenRedirect(portal: Portal, role: Role): string | null {
  if (portal === "student" && role === "STUDENT") return "/student";
  if (portal === "instructor" && role === "INSTRUCTOR") return "/instructor";
  return null;
}

// Path prefixes each role is permitted to be redirected to. ADMIN may view both
// portals (for support) plus the admin area; students and instructors are
// confined to their own portal.
const ROLE_PATH_PREFIXES: Record<Role, readonly string[]> = {
  STUDENT: ["/student"],
  INSTRUCTOR: ["/instructor"],
  ADMIN: ["/student", "/instructor", "/admin"],
};

/**
 * True only for same-origin relative paths. Rejects absolute URLs, protocol
 * relative URLs ("//evil.com") and backslash tricks ("/\\evil.com") that some
 * browsers normalise into protocol-relative navigations.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/\\")) return false;
  if (value.includes("\\")) return false;
  return true;
}

/** Screens a freshly authenticated user must never be sent back to. */
function isNonDestinationPath(path: string): boolean {
  return (
    path === "/login" ||
    path.endsWith("/login") ||
    path === "/register" ||
    path.endsWith("/register") ||
    path === "/instructor/application"
  );
}

function isPathAllowedForRole(role: Role, path: string): boolean {
  // Never bounce a freshly authenticated user back to a login or onboarding
  // screen; the role dashboard (or validated request detail) is the destination.
  if (isNonDestinationPath(path)) return false;
  const prefixes = ROLE_PATH_PREFIXES[role] ?? [];
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

/**
 * Resolve where to send a user after a successful sign-in.
 *
 * @param role  the VERIFIED role (from the session/database)
 * @param next  optional client-supplied return URL (validated here)
 */
export function resolvePostLoginPath(role: Role, next?: string | null): string {
  if (isSafeRelativePath(next) && isPathAllowedForRole(role, next)) {
    return next;
  }
  return homePathForRole(role);
}

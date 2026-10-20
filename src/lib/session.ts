import "server-only";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth-options";
import { prisma } from "@/lib/db";
import { homePathForRole, type Role } from "@/lib/domain";

/** The authoritative user record, re-read from the database on every call. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  suspended: boolean;
};

export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "SUSPENDED";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Return the signed-in user, or null when unauthenticated or suspended. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const sessionId = session?.user?.id;
  if (!sessionId) return null;

  const user = await prisma.user.findUnique({ where: { id: sessionId } });
  if (!user) return null;

  // Suspension is enforced here, so it applies immediately even to live sessions.
  if (user.suspended) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    suspended: user.suspended,
  };
}

/**
 * For layouts: redirect to the relevant portal login (carrying `next`) when
 * unauthenticated. `loginPath` defaults to the generic sign-in screen.
 */
export async function requireUserForPage(
  nextPath: string,
  loginPath = "/login",
): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`${loginPath}?next=${encodeURIComponent(nextPath)}`);
  return user;
}

/**
 * For layouts: ensure the user holds one of the allowed roles, otherwise send
 * them to their own portal root. Administrators may view both portals for
 * support purposes.
 */
export async function requireRoleForPage(
  allowed: Role[],
  nextPath: string,
  loginPath = "/login",
): Promise<SessionUser> {
  const user = await requireUserForPage(nextPath, loginPath);
  if (!allowed.includes(user.role)) {
    redirect(homePathForRole(user.role));
  }
  return user;
}

/** For server actions / API routes: throw instead of redirecting. */
export async function requireRole(allowed: Role[]): Promise<SessionUser> {
  const session = await getServerSession(authOptions);
  const sessionId = session?.user?.id;
  if (!sessionId) throw new AuthError("UNAUTHENTICATED", "You must be signed in.");

  const user = await prisma.user.findUnique({ where: { id: sessionId } });
  if (!user) throw new AuthError("UNAUTHENTICATED", "Session is no longer valid.");
  if (user.suspended) throw new AuthError("SUSPENDED", "This account is suspended.");
  if (!allowed.includes(user.role as Role)) {
    throw new AuthError("FORBIDDEN", "You do not have permission to perform this action.");
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    suspended: user.suspended,
  };
}

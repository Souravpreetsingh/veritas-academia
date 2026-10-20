import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import {
  isSafeRelativePath,
  resolveLoginScreenRedirect,
  resolvePostLoginPath,
} from "@/lib/login-routing";
import PortalLoginScreen from "@/components/PortalLoginScreen";

export const metadata = { title: "Instructor sign in — Veritas Academia" };

// Instructor portal sign-in. Instructor access exists only for accounts whose
// application has been approved; the portal guards and business-action services
// enforce that on the server. This screen is reachable while a student session
// exists so the visitor can switch accounts; a student who signs in here is
// pointed at the application-status screen, never at instructor functionality.
export default async function InstructorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = isSafeRelativePath(next) ? next : undefined;

  const user = await getSessionUser();
  if (user && resolveLoginScreenRedirect("instructor", user.role)) {
    redirect(resolvePostLoginPath(user.role, safeNext));
  }

  return (
    <PortalLoginScreen portal="instructor" next={safeNext} signedInRole={user?.role ?? null} />
  );
}

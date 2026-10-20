import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import {
  isSafeRelativePath,
  resolveLoginScreenRedirect,
  resolvePostLoginPath,
} from "@/lib/login-routing";
import PortalLoginScreen from "@/components/PortalLoginScreen";

export const metadata = { title: "Student sign in — Veritas Academia" };

// Student portal sign-in. Lives in the (auth) group so it is NOT wrapped by the
// /student/* authorization guard. A same-role session is sent to its dashboard;
// a session in another role stays on this screen so the account can be switched.
export default async function StudentLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = isSafeRelativePath(next) ? next : undefined;

  const user = await getSessionUser();
  if (user && resolveLoginScreenRedirect("student", user.role)) {
    redirect(resolvePostLoginPath(user.role, safeNext));
  }

  return (
    <PortalLoginScreen portal="student" next={safeNext} signedInRole={user?.role ?? null} />
  );
}

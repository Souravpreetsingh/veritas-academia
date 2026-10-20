import { redirect } from "next/navigation";
import { instructorPortalAccess } from "@/lib/authorization";
import { homePathForRole } from "@/lib/domain";
import { hasInstructorApplication } from "@/lib/instructor-applications";
import { requireUserForPage } from "@/lib/session";

// Server-enforced authorization gate for every /instructor/* route.
// Administrators may view the instructor portal for support purposes.
//
// A student with an instructor application on file is routed to the public
// application-status screen; no instructor functionality is rendered until
// approval promotes the account to INSTRUCTOR. Everyone else is sent to their
// own portal.
export default async function InstructorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUserForPage("/instructor", "/instructor/login");
  const hasApplication =
    user.role === "STUDENT" ? await hasInstructorApplication(user.id) : false;
  const access = instructorPortalAccess(user.role, hasApplication);

  if (access === "allow") return children;
  if (access === "application-status") redirect("/instructor/application");
  redirect(homePathForRole(user.role));
}

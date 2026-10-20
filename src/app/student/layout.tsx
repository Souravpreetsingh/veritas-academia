import { requireRoleForPage } from "@/lib/session";

// Server-enforced authorization gate for every /student/* route.
// Administrators may view the student portal for support purposes.
export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRoleForPage(["STUDENT", "ADMIN"], "/student", "/student/login");
  return children;
}

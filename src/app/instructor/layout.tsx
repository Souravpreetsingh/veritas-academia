import { requireRoleForPage } from "@/lib/session";

// Server-enforced authorization gate for every /instructor/* route.
// Administrators may view the instructor portal for support purposes.
export default async function InstructorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRoleForPage(["INSTRUCTOR", "ADMIN"], "/instructor");
  return children;
}

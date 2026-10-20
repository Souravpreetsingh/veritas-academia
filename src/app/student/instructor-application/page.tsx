import Shell from "@/components/Shell";
import InstructorApplicationForm from "@/components/InstructorApplicationForm";
import { requireUserForPage } from "@/lib/session";

// Student-facing instructor application form + status. Guarded by the student
// portal layout (STUDENT or ADMIN).
export default async function InstructorApplicationPage() {
  const user = await requireUserForPage("/student/instructor-application");

  return (
    <Shell
      persona="student"
      label="Instructor Application"
      group="instructor-application"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <InstructorApplicationForm />
    </Shell>
  );
}

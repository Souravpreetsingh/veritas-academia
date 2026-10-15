import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { homePathForRole } from "@/lib/domain";
import RegisterForm from "./register-form";

export const metadata = { title: "Create account — Veritas Academia" };

export default async function RegisterPage() {
  const user = await getSessionUser();
  if (user) redirect(homePathForRole(user.role));

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="font-display font-bold text-2xl tracking-tight text-on-surface">
            Veritas <span className="text-secondary neon-text-cyan">Academia</span>
          </div>
          <p className="mt-2 text-sm text-on-surface-variant">
            Create a student account to get started.
          </p>
        </div>
        <div className="rounded-lg border border-outline-variant/40 bg-surface-container p-8">
          <RegisterForm />
        </div>
      </div>
    </div>
  );
}

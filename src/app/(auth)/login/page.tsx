import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { homePathForRole } from "@/lib/domain";
import { isSafeRelativePath } from "@/lib/login-routing";
import LoginForm from "./login-form";

export const metadata = { title: "Sign in — Veritas Academia" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  if (user) redirect(homePathForRole(user.role));

  // Only allow same-origin relative paths to prevent open redirects. Role
  // confinement happens after sign-in via resolvePostLoginPath.
  const next = isSafeRelativePath(params.next) ? params.next : undefined;

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="font-display font-bold text-2xl tracking-tight text-on-surface">
            Veritas <span className="text-secondary neon-text-cyan">Academia</span>
          </div>
          <p className="mt-2 text-sm text-on-surface-variant">
            Sign in to your account to continue.
          </p>
        </div>
        <div className="rounded-lg border border-outline-variant/40 bg-surface-container p-8">
          <LoginForm next={next} />
        </div>
      </div>
    </div>
  );
}

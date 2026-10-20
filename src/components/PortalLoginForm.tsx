"use client";

import { useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { canUsePortal, resolvePostLoginPath, type Portal } from "@/lib/login-routing";
import { isRole } from "@/lib/domain";

// Shared credential form for both portals. Authentication uses the single
// existing Auth.js credentials provider — there is no second identity store.
// The destination is chosen from the VERIFIED role returned by the fresh
// session, never from client input.
export default function PortalLoginForm({ portal, next }: { portal: Portal; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }

    setLoading(true);
    try {
      const result = await signIn("credentials", { email, password, redirect: false });

      // Rate limiting responses from the credentials callback: 429 when the
      // attempt budget is exhausted, 503 when the limiter store is unavailable
      // (fail closed). Both use a NextAuth-shaped body; detect them by status.
      if (result?.status === 429) {
        setError("Too many sign-in attempts. Please wait a moment and try again.");
        return;
      }
      if (result?.status === 503) {
        setError("Sign-in is temporarily unavailable. Please try again shortly.");
        return;
      }

      if (result?.error) {
        setError("Invalid email or password.");
        return;
      }

      // Read the freshly-established session to obtain the verified role.
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const session = response.ok ? await response.json() : null;
      const role = session?.user?.role;

      if (!isRole(role)) {
        setError("Signed in, but the session could not be verified. Please try again.");
        return;
      }

      // A pending instructor applicant still holds the student role until an
      // administrator approves the application. Send them to the status screen
      // rather than the student dashboard; never grant instructor access.
      if (portal === "instructor" && role === "STUDENT") {
        const applicationResponse = await fetch("/api/instructor/applications/me", {
          cache: "no-store",
        });
        const applicationData = applicationResponse.ok ? await applicationResponse.json() : null;
        if (applicationData?.application) {
          router.push("/instructor/application");
          router.refresh();
          return;
        }
        await signOut({ redirect: false }).catch(() => undefined);
        setError(
          "No instructor application was found for this account. Apply to teach, or use the student sign-in page.",
        );
        router.refresh();
        return;
      }

      if (!canUsePortal(portal, role)) {
        await signOut({ redirect: false }).catch(() => undefined);
        setError(
          role === "INSTRUCTOR"
            ? "This account is registered as an instructor. Use the instructor sign-in page."
            : "This account cannot sign in to the student portal. Use the sign-in page for its role.",
        );
        router.refresh();
        return;
      }

      const target = resolvePostLoginPath(role, next);
      router.push(target);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded bg-surface border border-outline-variant/50 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-secondary focus:outline-none disabled:opacity-50";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error ? (
        <div
          role="alert"
          className="rounded border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </div>
      ) : null}

      <div>
        <label
          htmlFor="email"
          className="mb-2 block text-xs font-label font-semibold uppercase tracking-widest text-on-surface-variant"
        >
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className={inputClass}
          placeholder="you@university.edu"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-2 block text-xs font-label font-semibold uppercase tracking-widest text-on-surface-variant"
        >
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            className={`${inputClass} pr-10`}
            placeholder="••••••••"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            disabled={loading}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-on-surface-variant hover:text-secondary disabled:opacity-50 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">
              {showPassword ? "visibility_off" : "visibility"}
            </span>
          </button>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className={`w-full rounded px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${
          portal === "instructor" ? "bg-primary text-on-primary" : "bg-secondary text-background"
        }`}
      >
        {loading ? "Signing in…" : `Sign in as ${portal === "instructor" ? "Instructor" : "Student"}`}
      </button>

      {portal === "student" ? (
        <p className="text-center text-sm text-on-surface-variant">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-secondary hover:underline">
            Create a student account
          </Link>
        </p>
      ) : (
        <div className="space-y-2 text-center text-sm text-on-surface-variant">
          <p>
            New instructor?{" "}
            <Link href="/instructor/register" className="text-secondary hover:underline">
              Apply to teach
            </Link>
          </p>
          <p className="text-xs">
            Instructor access is granted only after an administrator approves your application. You
            can sign in to track your application status.
          </p>
        </div>
      )}
    </form>
  );
}

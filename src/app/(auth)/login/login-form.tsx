"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email or password.");
      return;
    }

    // Determine the destination from the fresh session (role-based).
    try {
      const res = await fetch("/api/auth/session");
      const session = await res.json();
      const role = session?.user?.role as string | undefined;
      const target = next ?? (role === "INSTRUCTOR" ? "/instructor" : "/student");
      router.push(target);
      router.refresh();
    } catch {
      router.push("/student");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="rounded border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="email" className="block text-xs font-label font-semibold uppercase tracking-widest text-on-surface-variant mb-2">
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
          className="w-full rounded bg-surface border border-outline-variant/50 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-secondary focus:outline-none disabled:opacity-50"
          placeholder="you@university.edu"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-xs font-label font-semibold uppercase tracking-widest text-on-surface-variant mb-2">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          className="w-full rounded bg-surface border border-outline-variant/50 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-secondary focus:outline-none disabled:opacity-50"
          placeholder="••••••••"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-secondary px-4 py-2.5 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-center text-sm text-on-surface-variant">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-secondary hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}

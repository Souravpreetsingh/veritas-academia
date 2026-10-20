"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Public registration always creates a STUDENT account. Instructor
      // access requires an approved application (later phase); administrator
      // access is granted only through a protected administrative process.
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error ?? "Registration failed. Please try again.");
        setLoading(false);
        return;
      }

      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        setError("Account created but sign-in failed. Please sign in manually.");
        setLoading(false);
        return;
      }

      router.push("/student");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
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
        <label htmlFor="name" className="block text-xs font-label font-semibold uppercase tracking-widest text-on-surface-variant mb-2">
          Full name
        </label>
        <input
          id="name"
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={loading}
          className="w-full rounded bg-surface border border-outline-variant/50 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-secondary focus:outline-none disabled:opacity-50"
          placeholder="Alex Morgan"
        />
      </div>

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
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          className="w-full rounded bg-surface border border-outline-variant/50 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-secondary focus:outline-none disabled:opacity-50"
          placeholder="At least 8 characters"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-secondary px-4 py-2.5 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {loading ? "Creating account…" : "Create student account"}
      </button>

      <p className="text-center text-sm text-on-surface-variant">
        Already have an account?{" "}
        <Link href="/student/login" className="text-secondary hover:underline">
          Student sign in
        </Link>
      </p>

      <p className="text-center text-xs text-on-surface-variant">
        Applying to teach?{" "}
        <Link href="/instructor/register" className="text-secondary hover:underline">
          Submit an instructor application
        </Link>
      </p>
    </form>
  );
}

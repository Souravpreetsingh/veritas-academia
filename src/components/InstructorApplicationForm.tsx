"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

// Minimum functional UI for the instructor-application flow. Uses the existing
// Neon Tokyo design tokens; no invented credentials, ratings or badges.

type ApplicationStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

interface Application {
  id: string;
  status: ApplicationStatus;
  fullName: string;
  email: string;
  expertise: string[];
  qualifications: string[];
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

const statusStyles: Record<ApplicationStatus, string> = {
  PENDING: "text-tertiary border-tertiary/40 bg-tertiary-container/20",
  APPROVED: "text-secondary border-secondary/40 bg-secondary-container/20",
  REJECTED: "text-error border-error/40 bg-error-container/20",
  WITHDRAWN: "text-on-surface-variant border-outline-variant/40 bg-surface-container",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return value;
  }
}

export default function InstructorApplicationForm({
  mode = "apply",
}: {
  mode?: "apply" | "register";
}) {
  const router = useRouter();
  const isRegister = mode === "register";
  const [application, setApplication] = useState<Application | null>(null);
  const [loading, setLoading] = useState(!isRegister);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [bio, setBio] = useState("");
  const [expertise, setExpertise] = useState("");
  const [qualifications, setQualifications] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (isRegister) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/instructor/applications/me");
        if (cancelled) return;
        if (response.ok) {
          const data = (await response.json()) as { application: Application | null };
          if (!cancelled) setApplication(data.application);
        }
      } catch {
        // Non-fatal: the form simply stays available.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRegister]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const response = await fetch(
        isRegister ? "/api/instructor/register" : "/api/instructor/applications",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName,
            email,
            phone,
            bio,
            expertise,
            qualifications,
            termsAccepted,
            ...(isRegister ? { password } : {}),
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        application?: Application;
        error?: string;
        fields?: Record<string, string>;
      };
      if (!response.ok) {
        setFieldErrors(data.fields ?? {});
        setMessage({ tone: "error", text: data.error ?? "Could not submit your application." });
        return;
      }

      if (isRegister) {
        // The account exists now; establish the session so the applicant can
        // immediately see the pending-approval status screen.
        const signInResult = await signIn("credentials", {
          // Prefer the server-normalized address so sign-in always matches the
          // account that was just created.
          email: data.application?.email ?? email.trim().toLowerCase(),
          password,
          redirect: false,
        });
        if (signInResult?.error) {
          setMessage({
            tone: "ok",
            text: "Account created. Sign in with your email and password to track the application.",
          });
          return;
        }
        router.push("/instructor/application");
        router.refresh();
        return;
      }

      setApplication(data.application ?? null);
      setMessage({ tone: "ok", text: "Application submitted for review." });
    } catch {
      setMessage({ tone: "error", text: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  async function onWithdraw(id: string) {
    setMessage(null);
    try {
      const response = await fetch(`/api/instructor/applications/${id}/withdraw`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => ({}))) as {
        application?: Application;
        error?: string;
      };
      if (!response.ok) {
        setMessage({ tone: "error", text: data.error ?? "Could not withdraw the application." });
        return;
      }
      setApplication(data.application ?? null);
      setMessage({ tone: "ok", text: "Application withdrawn. You may reapply." });
    } catch {
      setMessage({ tone: "error", text: "Network error. Please try again." });
    }
  }

  if (loading) {
    return <p className="text-on-surface-variant text-sm">Loading your application…</p>;
  }

  if (application) {
    return (
      <div className="max-w-3xl">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="font-headline text-2xl font-bold text-on-surface">
            Instructor Application
          </h1>
          <span
            className={`px-3 py-1 rounded border text-xs font-label uppercase tracking-wider ${statusStyles[application.status]}`}
          >
            {application.status}
          </span>
        </div>

        <div className="bg-surface-container border border-outline-variant/40 rounded p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-on-surface-variant text-xs mb-1">Applicant</div>
              <div className="text-on-surface">{application.fullName}</div>
            </div>
            <div>
              <div className="text-on-surface-variant text-xs mb-1">Submitted</div>
              <div className="text-on-surface">{formatDate(application.createdAt)}</div>
            </div>
            <div>
              <div className="text-on-surface-variant text-xs mb-1">Reviewed</div>
              <div className="text-on-surface">{formatDate(application.reviewedAt)}</div>
            </div>
            <div>
              <div className="text-on-surface-variant text-xs mb-1">Expertise</div>
              <div className="text-on-surface">{application.expertise.join(", ") || "—"}</div>
            </div>
          </div>

          {application.status === "REJECTED" && application.rejectionReason ? (
            <div className="border border-error/40 bg-error-container/10 rounded p-4 text-sm">
              <div className="text-error font-label text-xs uppercase tracking-wider mb-1">
                Rejection reason
              </div>
              <p className="text-on-surface">{application.rejectionReason}</p>
            </div>
          ) : null}

          {application.status === "PENDING" ? (
            <div className="flex items-center justify-between gap-4 pt-2">
              <p className="text-on-surface-variant text-xs">
                Your application is under administrator review.
              </p>
              <button
                type="button"
                onClick={() => onWithdraw(application.id)}
                className="px-3 py-1.5 rounded border border-outline-variant/50 text-on-surface-variant hover:text-error hover:border-error/50 text-xs transition-colors"
              >
                Withdraw application
              </button>
            </div>
          ) : null}

          {application.status === "WITHDRAWN" || application.status === "REJECTED" ? (
            <p className="text-on-surface-variant text-xs pt-2">
              You may submit a new application. Reload this page to start a fresh submission.
            </p>
          ) : null}
        </div>

        {message ? (
          <p
            className={`mt-4 text-sm ${message.tone === "ok" ? "text-secondary" : "text-error"}`}
            role="status"
          >
            {message.text}
          </p>
        ) : null}
      </div>
    );
  }

  const inputClass =
    "w-full bg-surface-container-low border border-outline-variant/50 text-on-surface placeholder:text-on-surface-variant/50 rounded px-3 py-2 text-sm focus:border-secondary focus:ring-1 focus:ring-secondary/40 outline-none transition-all font-body";

  return (
    <div className="max-w-3xl">
      <h1 className="font-headline text-2xl font-bold text-on-surface mb-1">
        {isRegister ? "Create your instructor account" : "Apply to become an instructor"}
      </h1>
      <p className="text-on-surface-variant text-sm mb-6">
        {isRegister
          ? "Tell us about your academic background and choose a password. An administrator reviews every application; instructor features unlock only after approval. You can sign in to track your status."
          : "Tell us about your academic background. An administrator will review your application. Approval is required before you can offer services."}
      </p>

      <form
        onSubmit={onSubmit}
        className="bg-surface-container border border-outline-variant/40 rounded p-6 space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-label text-on-surface-variant mb-1" htmlFor="fullName">
              Full name
            </label>
            <input
              id="fullName"
              className={inputClass}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
            {fieldErrors.fullName ? (
              <p className="text-error text-xs mt-1">{fieldErrors.fullName}</p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-label text-on-surface-variant mb-1" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {fieldErrors.email ? (
              <p className="text-error text-xs mt-1">{fieldErrors.email}</p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-label text-on-surface-variant mb-1" htmlFor="phone">
              Phone (optional)
            </label>
            <input
              id="phone"
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            {fieldErrors.phone ? (
              <p className="text-error text-xs mt-1">{fieldErrors.phone}</p>
            ) : null}
          </div>
        </div>

        <div>
          <label className="block text-xs font-label text-on-surface-variant mb-1" htmlFor="bio">
            Background & experience
          </label>
          <textarea
            id="bio"
            rows={5}
            className={inputClass}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            required
          />
          {fieldErrors.bio ? <p className="text-error text-xs mt-1">{fieldErrors.bio}</p> : null}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-label text-on-surface-variant mb-1" htmlFor="expertise">
              Areas of expertise (comma-separated)
            </label>
            <input
              id="expertise"
              className={inputClass}
              value={expertise}
              onChange={(e) => setExpertise(e.target.value)}
              placeholder="e.g. Statistical Analysis, Research Methods"
              required
            />
            {fieldErrors.expertise ? (
              <p className="text-error text-xs mt-1">{fieldErrors.expertise}</p>
            ) : null}
          </div>
          <div>
            <label
              className="block text-xs font-label text-on-surface-variant mb-1"
              htmlFor="qualifications"
            >
              Qualifications (comma-separated)
            </label>
            <input
              id="qualifications"
              className={inputClass}
              value={qualifications}
              onChange={(e) => setQualifications(e.target.value)}
              placeholder="e.g. PhD Economics, MSc Statistics"
              required
            />
            {fieldErrors.qualifications ? (
              <p className="text-error text-xs mt-1">{fieldErrors.qualifications}</p>
            ) : null}
          </div>
        </div>

        {isRegister ? (
          <div>
            <label
              className="block text-xs font-label text-on-surface-variant mb-1"
              htmlFor="password"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {fieldErrors.password ? (
              <p className="text-error text-xs mt-1">{fieldErrors.password}</p>
            ) : null}
            <p className="mt-1 text-xs text-on-surface-variant">
              At least 8 characters. You will use this password to sign in and track your application.
            </p>
          </div>
        ) : null}

        <label className="flex items-start gap-3 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            className="mt-1 accent-[#ff2d78]"
          />
          <span>
            I confirm the information provided is accurate and understand that approval is required
            before offering services.
          </span>
        </label>
        {fieldErrors.termsAccepted ? (
          <p className="text-error text-xs">{fieldErrors.termsAccepted}</p>
        ) : null}

        <div className="flex items-center gap-4 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded bg-primary text-on-primary text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting
              ? "Submitting…"
              : isRegister
                ? "Create instructor account"
                : "Submit application"}
          </button>
          {message ? (
            <span
              className={`text-sm ${message.tone === "ok" ? "text-secondary" : "text-error"}`}
              role="status"
            >
              {message.text}
            </span>
          ) : null}
        </div>
      </form>

      {isRegister ? (
        <p className="mt-4 text-center text-sm text-on-surface-variant">
          Already have an account?{" "}
          <Link href="/instructor/login" className="text-secondary hover:underline">
            Instructor sign in
          </Link>
        </p>
      ) : null}
    </div>
  );
}

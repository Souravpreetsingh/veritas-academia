"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney, formatTurnaround } from "@/lib/format";

// Client-side wizard form for step 02 (Requirements & Scope) / 04 (Review &
// Dispatch) of the service-request flow.
//
// The form only ever sends ids, text and the chosen turnaround: the price the
// student sees is recomputed from the selected service's REAL amount and is
// displayed for confirmation, while the server decides the authoritative price
// and rejects any turnaround the service does not offer.

export interface FormService {
  id: string;
  code: string;
  name: string;
  amountMinor: number;
  currency: string;
  turnaroundHours: number;
}

export interface ServiceRequestFormProps {
  instructorId: string;
  instructorName: string;
  instructorHeadline: string | null;
  services: FormService[];
  selectedServiceId: string;
}

type FieldErrors = Record<string, string>;

export default function ServiceRequestForm({
  instructorName,
  instructorHeadline,
  services,
  selectedServiceId,
}: ServiceRequestFormProps) {
  const router = useRouter();

  const [serviceId, setServiceId] = useState(selectedServiceId);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [deadline, setDeadline] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const service = useMemo(
    () => services.find((s) => s.id === serviceId) ?? services[0],
    [services, serviceId],
  );

  if (!service) {
    return (
      <div className="rounded-xl bg-surface-container/60 border border-error/40 p-6 text-sm text-on-surface-variant">
        This instructor has no active services to request.
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setMessage(null);

    if (!consent) {
      setErrors({ consent: "Confirm the declaration before continuing." });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/student/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          title,
          instructions,
          turnaroundHours: service.turnaroundHours,
          deadlineAt: deadline ? new Date(deadline).toISOString() : undefined,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        fields?: FieldErrors;
        error?: string;
      };

      if (!response.ok || !payload.id) {
        setErrors(payload.fields ?? {});
        setMessage(payload.error ?? "Could not create the request. Please review the form.");
        return;
      }

      router.push(`/student/review-submit?request=${encodeURIComponent(payload.id)}`);
    } catch {
      setMessage("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldError = (key: string) =>
    errors[key] ? (
      <p className="text-[11px] text-error mt-1">{errors[key]}</p>
    ) : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {message ? (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-error-container/30 border border-error/40 text-xs text-on-surface">
          <span className="material-symbols-outlined text-error text-base shrink-0">error</span>
          <span>{message}</span>
        </div>
      ) : null}

      {/* Selected instructor anchor */}
      <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-lg bg-surface-container-highest border border-outline-variant/60 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary">school</span>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
              Assigned instructor
            </div>
            <div className="font-headline font-bold text-sm text-on-surface truncate">
              {instructorName}
            </div>
            {instructorHeadline ? (
              <div className="text-xs font-body text-on-surface-variant truncate">
                {instructorHeadline}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Step 01 — service selection */}
      <div className="space-y-2">
        <label className="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
          01 · Service selection
        </label>
        <select
          value={service.id}
          onChange={(e) => setServiceId(e.target.value)}
          className="w-full bg-surface-container-low border border-outline-variant/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface text-sm rounded-lg px-3 py-2.5 outline-none font-body appearance-none cursor-pointer"
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {fieldError("serviceId")}
      </div>

      {/* Step 02 — requirements & scope */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2 space-y-2">
          <label
            htmlFor="request-title"
            className="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant"
          >
            02 · Request title
          </label>
          <input
            id="request-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            required
            placeholder="e.g. Literature Review — Climate Policy Corpus"
            className="w-full bg-surface-container-low border border-outline-variant/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface placeholder:text-on-surface-variant/50 text-sm rounded-lg px-3 py-2.5 outline-none font-body"
          />
          {fieldError("title")}
        </div>

        <div className="md:col-span-2 space-y-2">
          <label
            htmlFor="request-instructions"
            className="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant"
          >
            Requirements &amp; scope
          </label>
          <textarea
            id="request-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={4000}
            required
            rows={5}
            placeholder="Describe the scope, methodology expectations, citation style and any constraints."
            className="w-full bg-surface-container-low border border-outline-variant/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface placeholder:text-on-surface-variant/50 text-sm rounded-lg px-3 py-2.5 outline-none font-body resize-y"
          />
          {fieldError("instructions")}
        </div>

        <div className="space-y-2">
          <label className="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
            Turnaround
          </label>
          <select
            value={service.turnaroundHours}
            disabled
            className="w-full bg-surface-container-low border border-outline-variant/50 text-on-surface text-sm rounded-lg px-3 py-2.5 outline-none font-body appearance-none cursor-not-allowed opacity-80"
          >
            <option value={service.turnaroundHours}>
              {formatTurnaround(service.turnaroundHours)}
            </option>
          </select>
          <p className="text-[11px] text-on-surface-variant">
            The only turnaround offered by this service.
          </p>
          {fieldError("turnaroundHours")}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="request-deadline"
            className="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant"
          >
            Expected deadline <span className="normal-case tracking-normal">(optional)</span>
          </label>
          <input
            id="request-deadline"
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full bg-surface-container-low border border-outline-variant/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface text-sm rounded-lg px-3 py-2.5 outline-none font-body"
          />
          {fieldError("deadlineAt")}
        </div>
      </div>

      {/* Price total — recomputed from the real service row */}
      <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-5">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
              Calculated total
            </div>
            <div className="text-xs font-body text-on-surface-variant">{service.name}</div>
          </div>
          <div className="text-right">
            <div className="font-headline font-bold text-2xl text-primary">
              {formatMoney(service.amountMinor, service.currency)}
            </div>
            <div className="text-[11px] font-label text-secondary flex items-center gap-1 justify-end">
              <span className="material-symbols-outlined text-xs">timer</span>
              {formatTurnaround(service.turnaroundHours)}
            </div>
          </div>
        </div>
      </div>

      <label className="flex items-start gap-3 p-3.5 rounded-lg bg-surface-container-low border border-outline-variant/40 cursor-pointer">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 accent-[#ff2d78]"
        />
        <span className="text-[11px] font-body text-on-surface-variant leading-relaxed">
          I confirm the manuscript and materials I attach are my own work, that I have the right to
          share them, and that this request is for legitimate academic support.
        </span>
      </label>
      {fieldError("consent")}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <span className="text-[11px] font-label text-on-surface-variant">
          Step 03 (documents) and Step 04 (review) follow.
        </span>
        <button
          type="submit"
          disabled={submitting}
          className="px-5 py-3 rounded-lg bg-primary text-on-primary hover:bg-primary-container disabled:opacity-60 disabled:cursor-not-allowed text-xs font-headline font-bold uppercase tracking-wider transition-all duration-150 flex items-center gap-2 shadow-[0_0_16px_rgba(255,45,120,0.3)]"
        >
          <span className="material-symbols-outlined text-base">
            {submitting ? "hourglass_top" : "arrow_forward"}
          </span>
          {submitting ? "Creating draft…" : "Save draft & continue"}
        </button>
      </div>
    </form>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { SCREENS } from "@/screens/manifest";
import { INSTRUCTOR_NAV, STUDENT_NAV } from "@/lib/nav";

const groups = [
  { key: "instructor", title: "Instructor portal", screens: SCREENS.filter((s) => s.persona === "instructor") },
  { key: "student", title: "Student portal", screens: SCREENS.filter((s) => s.persona === "student") },
  { key: "public", title: "Public site", screens: SCREENS.filter((s) => s.persona === "public") },
] as const;

/** Sidebar-only destinations (no designed screen yet) — still navigable. */
const pending = [
  ...INSTRUCTOR_NAV.flatMap((s) => s.items)
    .filter((i) => !SCREENS.some((s) => s.route === i.route))
    .map((i) => ({ route: i.route, label: i.label, parent: "Instructor portal" })),
  ...STUDENT_NAV.flatMap((s) => s.items)
    .filter((i) => !SCREENS.some((s) => s.route === i.route))
    .map((i) => ({ route: i.route, label: i.label, parent: "Student portal" })),
];

export default function AppLauncher() {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed bottom-4 right-4 z-[100] print:hidden">
      {open ? (
        <div className="w-[300px] max-h-[70vh] overflow-y-auto rounded-xl bg-surface-container border border-outline-variant/40 shadow-[0_0_30px_rgba(0,0,0,0.6)]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/30 sticky top-0 bg-surface-container">
            <span className="text-[10px] font-label font-bold tracking-widest uppercase text-secondary neon-text-cyan">
              Screen index
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-on-surface-variant hover:text-primary text-xs font-label"
            >
              Close
            </button>
          </div>

          <div className="p-3 space-y-4">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="px-1 pb-1.5 text-[10px] font-label font-semibold tracking-widest uppercase text-on-surface-variant/70">
                  {g.title}
                </div>
                <ul className="space-y-0.5">
                  {g.screens.map((s) => (
                    <li key={s.route}>
                      <Link
                        href={s.route}
                        onClick={() => setOpen(false)}
                        className="flex items-center justify-between px-2 py-1.5 rounded text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
                      >
                        <span className="truncate">{s.label}</span>
                        <span className="font-mono text-[10px] text-outline shrink-0 ml-2">{s.slug}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {pending.length ? (
              <div>
                <div className="px-1 pb-1.5 text-[10px] font-label font-semibold tracking-widest uppercase text-tertiary/70">
                  Pending screens
                </div>
                <ul className="space-y-0.5">
                  {pending.map((p) => (
                    <li key={p.route}>
                      <Link
                        href={p.route}
                        onClick={() => setOpen(false)}
                        className="flex items-center justify-between px-2 py-1.5 rounded text-xs text-on-surface-variant/60 hover:bg-surface-container-high hover:text-tertiary transition-colors"
                      >
                        <span className="truncate">{p.label}</span>
                        <span className="font-mono text-[9px] text-outline shrink-0 ml-2">pending</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-container-high/90 backdrop-blur border border-secondary/40 text-secondary text-xs font-label font-semibold shadow-[0_0_16px_rgba(0,255,204,0.2)] hover:border-secondary/70 transition-colors"
          aria-label="Open screen index"
        >
          <span className="material-symbols-outlined text-[16px]">widgets</span>
          Screens
        </button>
      )}
    </div>
  );
}

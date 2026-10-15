"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { INSTRUCTOR_NAV, STUDENT_NAV, type NavItem, type NavSection } from "@/lib/nav";

type Persona = "instructor" | "student";

const badgeClasses: Record<string, string> = {
  primary: "bg-primary text-on-primary",
  secondary: "bg-secondary text-on-secondary",
  outline: "bg-surface-container-highest text-secondary border border-secondary/30",
};

/* ------------------------------------------------------------------ */
/*  Instructor sidebar                                                 */
/* ------------------------------------------------------------------ */
function InstructorItem({ item, active }: { item: NavItem; active: boolean }) {
  const cls = active
    ? "flex items-center justify-between px-3 py-2 rounded transition-all bg-primary-container text-on-primary-container font-semibold neon-glow-pink border-l-2 border-primary"
    : "flex items-center justify-between px-3 py-2 text-xs rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all";
  return (
    <Link href={item.route} className={cls} aria-current={active ? "page" : undefined}>
      <span className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
        <span className="font-medium">{item.label}</span>
      </span>
      {item.badge ? (
        <span className={`px-1.5 py-0.5 text-[10px] font-label font-bold rounded ${badgeClasses[item.badge.tone]}`}>
          {item.badge.text}
        </span>
      ) : null}
    </Link>
  );
}

function InstructorSidebar({ active }: { active: string }) {
  const sections: NavSection[] = INSTRUCTOR_NAV;
  return (
    <aside className="fixed left-0 top-0 h-full w-[260px] bg-surface-container-lowest z-50 flex flex-col justify-between border-r border-outline-variant/30">
      <div className="flex flex-col flex-1 overflow-y-auto">
        <div className="p-5 pb-4 border-b border-outline-variant/20">
          <div className="flex items-center gap-2.5">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_10px_#ff2d78]" />
            <span className="font-headline font-bold text-base tracking-wider text-on-surface">
              VERITAS ACADEMIA
            </span>
          </div>
          <div className="mt-1 text-[10px] font-label tracking-widest text-secondary uppercase neon-text-cyan">
            ACADEMIC VAULT • ORIGINALITY GRID 2.4
          </div>
        </div>

        {sections.map((section) => (
          <div key={section.heading} className="px-3 py-4">
            <div className="px-3 pb-2 text-[10px] font-label font-bold tracking-widest uppercase text-on-surface-variant/70">
              {section.heading}
            </div>
            <nav className="space-y-1">
              {section.items.map((item) => (
                <InstructorItem key={item.path} item={item} active={item.path === active} />
              ))}
            </nav>
          </div>
        ))}
      </div>

      <div className="p-3.5 m-3 rounded bg-surface-container border border-outline-variant/30">
        <div className="flex items-start gap-3">
          <div className="relative flex-shrink-0">
            <div className="w-9 h-9 rounded bg-surface-container-highest flex items-center justify-center border border-primary/40">
              <span className="material-symbols-outlined text-primary text-[20px]">psychology</span>
            </div>
            <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface-container-lowest">
              <span className="material-symbols-outlined text-secondary text-[12px]">verified</span>
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-on-surface truncate">Dr. Ananya Sharma</div>
            <div className="text-[10px] text-on-surface-variant truncate font-label">Senior Faculty Fellow</div>
            <div className="text-[9px] text-secondary truncate font-label">Oxford / Cambridge Exch.</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Student sidebar                                                    */
/* ------------------------------------------------------------------ */
function StudentItem({ item, active }: { item: NavItem; active: boolean }) {
  const cls = active
    ? "flex items-center gap-3 px-3 py-2 rounded-r transition-all duration-150 bg-surface-variant text-primary border-l-2 border-primary font-medium"
    : "flex items-center gap-3 px-3 py-2 text-xs text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-r transition-all duration-150";
  return (
    <Link href={item.route} className={cls} aria-current={active ? "page" : undefined}>
      <span className="material-symbols-outlined text-base">{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );
}

function StudentSidebar({ active }: { active: string }) {
  const sections: NavSection[] = STUDENT_NAV;
  return (
    <aside className="fixed left-0 top-0 h-full w-[260px] bg-surface-container-low z-50 flex flex-col justify-between border-r border-outline-variant/40 shadow-[4px_0_24px_rgba(0,0,0,0.5)]">
      <div className="flex flex-col flex-1 min-h-0">
        <div className="px-5 pt-5 pb-4 border-b border-outline-variant/30">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded bg-surface-variant flex items-center justify-center glow-border-subtle">
              <span className="material-symbols-outlined text-primary text-xl glow-text-primary">auto_stories</span>
            </div>
            <div>
              <div className="font-headline font-bold text-sm tracking-wider text-on-surface flex items-center gap-1.5">
                <span>VERITAS</span>
                <span className="text-primary glow-text-primary">ACADEMIA</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
                <span className="font-label text-[10px] tracking-widest uppercase text-on-surface-variant">
                  Originality Grid 2.4
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-3 py-4 space-y-6">
          {sections.map((section) => (
            <div key={section.heading} className="space-y-1">
              <div className="px-3 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/70 font-semibold mb-2">
                {section.heading}
              </div>
              <nav className="space-y-0.5">
                {section.items.map((item) => (
                  <StudentItem key={item.path} item={item} active={item.path === active} />
                ))}
              </nav>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3 border-t border-outline-variant/30 bg-surface-container-lowest/80">
        <div className="p-2.5 rounded bg-surface-container-high/60 border border-outline-variant/40 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-primary-container border border-primary/40 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-on-primary-container text-[18px]">person</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-headline font-semibold text-xs text-on-surface truncate">Elena Vance</div>
              <div className="text-[10px] text-on-surface-variant truncate">PhD Cand. / Epistemology</div>
              <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-variant border border-secondary/30 text-[9px] font-label text-secondary truncate">
                <span className="w-1 h-1 rounded-full bg-secondary" />
                <span>Stanford / Oxford Exch.</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Account switch"
            className="text-on-surface-variant hover:text-secondary p-1 rounded hover:bg-surface-variant transition-colors"
          >
            <span className="material-symbols-outlined text-base">unfold_more</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Headers                                                            */
/* ------------------------------------------------------------------ */
function InstructorHeader({ label }: { label: string }) {
  return (
    <header className="fixed top-0 left-[260px] right-0 h-16 bg-surface/90 backdrop-blur-xl border-b border-outline-variant/20 z-40 px-6">
      <div className="h-full w-full flex items-center justify-between gap-6">
        <div className="flex items-center gap-4 min-w-max">
          <div className="flex items-center gap-1.5 text-xs font-label text-on-surface-variant">
            <span className="text-on-surface-variant/80">Instructor Portal</span>
            <span className="text-outline-variant">/</span>
            <span className="text-secondary font-medium">{label}</span>
          </div>
          <div className="h-4 w-[1px] bg-outline-variant/40" />
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-surface-container border border-outline-variant/20 text-[10px] font-label text-on-surface-variant">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-ping" />
            <span className="font-mono">INSTRUCTOR NODE WITNESS • Synced #8491</span>
          </div>
        </div>

        <div className="flex-1 max-w-xl">
          <div className="relative flex items-center w-full">
            <span className="material-symbols-outlined absolute left-3 text-[18px] text-on-surface-variant/60">search</span>
            <input
              className="w-full h-9 pl-9 pr-4 rounded bg-surface-container-low border border-outline-variant/30 text-xs text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:border-secondary focus:ring-1 focus:ring-secondary/40 font-body transition-all"
              placeholder="Search student requests, IDs, manuscripts, or messages... (⌘K)"
              type="text"
            />
          </div>
        </div>

        <div className="flex items-center gap-3.5 min-w-max">
          <div className="hidden xl:flex items-center px-2.5 py-1 rounded bg-surface-container-high border border-outline-variant/30 text-[10px] font-label text-tertiary">
            <span className="material-symbols-outlined text-[14px] mr-1 text-tertiary">history_edu</span>
            Fall 2025 Review Cycle
          </div>
          <button className="relative p-2 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors">
            <span className="material-symbols-outlined text-[20px]">notifications</span>
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_#ff2d78]" />
          </button>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary-container/40 border border-secondary/40 text-[11px] font-label text-secondary">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary shadow-[0_0_6px_#00ffcc]" />
            <span>Available for Requests</span>
          </div>
          <div className="h-4 w-[1px] bg-outline-variant/40" />
          <div className="flex items-center gap-2.5 pl-1 cursor-pointer">
            <div className="text-right hidden sm:block">
              <div className="text-xs font-semibold text-on-surface leading-tight">Dr. Ananya</div>
              <div className="text-[10px] text-on-surface-variant font-label">(Instructor)</div>
            </div>
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shadow-[0_0_10px_rgba(255,45,120,0.4)]">
              <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function StudentHeader({ label }: { label: string }) {
  return (
    <header className="fixed top-0 left-[260px] right-0 h-16 bg-surface/85 backdrop-blur-xl border-b border-outline-variant/30 z-40 px-6 flex items-center justify-between shadow-[0_4px_20px_rgba(0,0,0,0.35)]">
      <div className="flex items-center gap-4 min-w-0">
        <div className="hidden xl:flex items-center gap-2 text-xs font-label text-on-surface-variant">
          <span className="text-on-surface-variant/80">Academic Portal</span>
          <span className="text-outline">/</span>
          <span className="text-on-surface font-medium truncate">{label}</span>
        </div>
        <div className="relative w-80 2xl:w-96">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
          <input
            className="w-full bg-surface-container-low border border-outline-variant/50 focus:border-secondary focus:ring-1 focus:ring-secondary/40 text-on-surface placeholder:text-on-surface-variant/60 text-xs rounded pl-9 pr-8 py-2 outline-none transition-all duration-150 font-body"
            placeholder="⌘K Search verified faculty, methodologies, or papers..."
            type="text"
          />
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-label text-on-surface-variant/60 border border-outline-variant/70 rounded px-1.5 py-0.5 bg-surface-container">
            ⌘K
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3.5 shrink-0">
        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded bg-tertiary-container/30 border border-tertiary/30 text-tertiary font-label text-[11px]">
          <span className="w-1.5 h-1.5 rounded-full bg-tertiary animate-ping" />
          <span>Fall 2025 Review Cycle</span>
          <span className="text-outline">•</span>
          <span className="text-tertiary font-medium">Priority Queue Active</span>
        </div>
        <Link
          href="/student/notifications"
          aria-label="Notifications"
          className="relative p-2 rounded bg-surface-container-high/60 border border-outline-variant/40 text-on-surface-variant hover:text-secondary hover:border-secondary/40 transition-colors"
        >
          <span className="material-symbols-outlined text-lg">notifications</span>
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_#ff2d78]" />
        </Link>
        <Link
          href="/student/new-service-request"
          className="flex items-center gap-2 px-3.5 py-2 rounded bg-surface-container-high border border-primary text-primary hover:text-on-primary-container hover:bg-primary-container text-xs font-headline font-semibold glow-btn-hover transition-all duration-200"
        >
          <span className="material-symbols-outlined text-sm">upload_file</span>
          <span>Upload Manuscript</span>
        </Link>
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */
export default function Shell({
  persona,
  label,
  group,
  mainClassName,
  children,
}: {
  persona: Persona;
  label: string;
  group: string;
  mainClassName?: string;
  children: ReactNode;
}) {
  const defaultMain =
    persona === "instructor"
      ? "w-full pt-16 bg-background min-h-screen px-8 py-6"
      : "relative pt-16 bg-background min-h-screen px-8 py-6 w-full";

  const router = useRouter();

  // The injected screen markup keeps its original `data-path="…"` anchors and
  // `href="#"` stubs from the mockups. Convert them into real navigations (or
  // at least stop them from jumping to the top of the page).
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;

      const path = anchor.getAttribute("data-path");
      const href = anchor.getAttribute("href") || "";

      if (path) {
        const sections: NavSection[] = persona === "instructor" ? INSTRUCTOR_NAV : STUDENT_NAV;
        const item: NavItem | undefined = sections
          .flatMap((s) => s.items)
          .find((i) => i.path === path);
        if (item) {
          event.preventDefault();
          router.push(item.route);
          return;
        }
      }

      if (href === "#" || href === "") {
        event.preventDefault();
      }
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [persona, router]);

  return (
    <>
      {persona === "instructor" ? (
        <InstructorSidebar active={group} />
      ) : (
        <StudentSidebar active={group} />
      )}
      <div className="pl-[260px]">
        {persona === "instructor" ? <InstructorHeader label={label} /> : <StudentHeader label={label} />}
        <main className={mainClassName || defaultMain}>{children}</main>
      </div>
    </>
  );
}

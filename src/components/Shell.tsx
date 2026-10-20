"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import SignOutButton from "@/components/SignOutButton";
import { navFor, type NavItem } from "@/lib/nav";
import type { Role } from "@/lib/domain";

type Persona = "instructor" | "student";

/**
 * Real signed-in identity, passed by server pages. Optional so loading and
 * error boundaries can render neutral chrome without inventing personal
 * details.
 */
export type ShellUser = {
  name: string;
  role: Role;
};

const ROLE_LABEL: Record<Role, string> = {
  STUDENT: "Student",
  INSTRUCTOR: "Instructor",
  ADMIN: "Administrator",
};

const SIDEBAR_ID = "portal-sidebar";

/* ------------------------------------------------------------------ */
/*  Shared pieces                                                      */
/* ------------------------------------------------------------------ */
function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const cls = active
    ? "flex items-center gap-3 px-3 py-2 rounded transition-all bg-primary-container text-on-primary-container font-semibold border-l-2 border-primary"
    : "flex items-center gap-3 px-3 py-2 rounded text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors";
  return (
    <Link href={item.route} className={cls} aria-current={active ? "page" : undefined}>
      <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
        {item.icon}
      </span>
      <span className="font-medium">{item.label}</span>
    </Link>
  );
}

function IdentityAvatar({ initial, size }: { initial: string | null; size: "sm" | "md" }) {
  const box = size === "sm" ? "w-8 h-8" : "w-9 h-9";
  return (
    <div
      className={`${box} rounded-full bg-primary-container border border-primary/40 flex items-center justify-center shrink-0`}
    >
      {initial ? (
        <span className="font-headline text-xs font-bold text-on-primary-container">{initial}</span>
      ) : (
        <span aria-hidden="true" className="material-symbols-outlined text-on-primary-container text-[18px]">
          person
        </span>
      )}
    </div>
  );
}

function useIdentity(user?: ShellUser, persona?: Persona) {
  const name = user?.name?.trim() ? user.name.trim() : null;
  return {
    name,
    initial: name ? name.charAt(0).toUpperCase() : null,
    roleLabel: user
      ? ROLE_LABEL[user.role]
      : persona === "instructor"
        ? "Instructor portal"
        : "Student portal",
    isAdmin: user?.role === "ADMIN",
  };
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */
function PortalSidebar({
  id,
  persona,
  active,
  user,
  open,
  onNavigate,
}: {
  id: string;
  persona: Persona;
  active: string;
  user?: ShellUser;
  open: boolean;
  onNavigate: () => void;
}) {
  const sections = navFor(persona);
  const identity = useIdentity(user, persona);

  return (
    <aside
      id={id}
      onClick={onNavigate}
      aria-label={persona === "instructor" ? "Instructor navigation" : "Student navigation"}
      className={`fixed inset-y-0 left-0 z-50 w-[260px] flex flex-col justify-between border-r border-outline-variant/30 bg-surface-container-lowest shadow-[4px_0_24px_rgba(0,0,0,0.4)] transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      } lg:translate-x-0`}
    >
      <div className="flex flex-col flex-1 min-h-0">
        <div className="p-5 pb-4 border-b border-outline-variant/20">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded bg-surface-variant flex items-center justify-center">
              <span aria-hidden="true" className="material-symbols-outlined text-primary text-xl">
                auto_stories
              </span>
            </div>
            <div className="min-w-0">
              <div className="font-headline font-bold text-sm tracking-wider text-on-surface">
                VERITAS <span className="text-primary">ACADEMIA</span>
              </div>
              <div className="text-[10px] font-label tracking-widest uppercase text-on-surface-variant mt-0.5">
                Academic Originality Platform
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-3 py-4 space-y-6">
          {sections.map((section) => (
            <div key={section.heading ?? "section"} className="space-y-1">
              {section.heading ? (
                <div className="px-3 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/70 font-semibold mb-2">
                  {section.heading}
                </div>
              ) : null}
              <nav className="space-y-0.5" aria-label={section.heading}>
                {section.items.map((item) => (
                  <NavLink key={item.path} item={item} active={item.path === active} />
                ))}
              </nav>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3 border-t border-outline-variant/30 bg-surface-container-lowest/80">
        <div className="p-2.5 rounded bg-surface-container-high/60 border border-outline-variant/40 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <IdentityAvatar initial={identity.initial} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="font-headline font-semibold text-xs text-on-surface truncate">
                {identity.name ?? "Your account"}
              </div>
              <div className="text-[10px] text-on-surface-variant truncate">
                {identity.roleLabel}
              </div>
            </div>
          </div>
          <SignOutButton
            iconOnly
            className="text-on-surface-variant hover:text-secondary p-1 rounded hover:bg-surface-variant transition-colors"
          />
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */
function PortalHeader({
  persona,
  label,
  user,
  onOpenNav,
}: {
  persona: Persona;
  label: string;
  user?: ShellUser;
  onOpenNav: () => void;
}) {
  const portalName = persona === "instructor" ? "Instructor Portal" : "Academic Portal";
  const identity = useIdentity(user, persona);

  return (
    <header className="fixed top-0 left-0 right-0 lg:left-[260px] z-40 h-16 border-b border-outline-variant/30 bg-surface/90 backdrop-blur-xl">
      <div className="h-full w-full flex items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onOpenNav}
            aria-label="Open navigation menu"
            aria-controls={SIDEBAR_ID}
            className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded bg-surface-container-high/60 border border-outline-variant/40 text-on-surface-variant hover:text-on-surface hover:border-secondary/40 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[20px]">
              menu
            </span>
          </button>
          <div className="flex items-center gap-1.5 text-xs font-label text-on-surface-variant min-w-0">
            <span className="hidden sm:inline text-on-surface-variant/80">{portalName}</span>
            <span aria-hidden="true" className="hidden sm:inline text-outline-variant">
              /
            </span>
            <span className="text-secondary font-medium truncate">{label}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {identity.isAdmin ? (
            <span className="hidden md:inline-flex items-center px-2.5 py-1 rounded text-[10px] font-label uppercase tracking-wider border border-tertiary/40 text-tertiary bg-tertiary-container/20">
              Administrator support view
            </span>
          ) : null}
          {persona === "student" ? (
            <Link
              href="/student/new-service-request"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">
                add
              </span>
              <span className="hidden sm:inline">New request</span>
            </Link>
          ) : null}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="text-right hidden sm:block min-w-0">
              <div className="text-xs font-semibold text-on-surface leading-tight truncate max-w-[160px]">
                {identity.name ?? "Your account"}
              </div>
              <div className="text-[10px] text-on-surface-variant font-label">
                {identity.roleLabel}
              </div>
            </div>
            <IdentityAvatar initial={identity.initial} size="sm" />
          </div>
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
  user,
  children,
}: {
  persona: Persona;
  label: string;
  group: string;
  mainClassName?: string;
  user?: ShellUser;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);

  // Escape closes the mobile drawer; body scroll is locked while it is open.
  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  const defaultMain =
    persona === "instructor"
      ? "w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
      : "relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full";

  return (
    <>
      {navOpen ? (
        <div
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      ) : null}
      <PortalSidebar
        id={SIDEBAR_ID}
        persona={persona}
        active={group}
        user={user}
        open={navOpen}
        onNavigate={() => setNavOpen(false)}
      />
      <div className="lg:pl-[260px]">
        <PortalHeader
          persona={persona}
          label={label}
          user={user}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className={mainClassName || defaultMain}>{children}</main>
      </div>
    </>
  );
}

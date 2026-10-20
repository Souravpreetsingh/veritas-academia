"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin section navigation, rendered inside the admin header. Active state is
// derived from the current path.
const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/applications", label: "Applications" },
] as const;

export default function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      className="max-w-5xl mx-auto px-6 pb-3 flex items-center gap-2 overflow-x-auto"
      aria-label="Admin sections"
    >
      {LINKS.map((link) => {
        const active =
          link.href === "/admin"
            ? pathname === "/admin"
            : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`px-3 py-1.5 rounded border text-xs font-label uppercase tracking-wider whitespace-nowrap transition-colors ${
              active
                ? "border-primary/60 text-primary bg-primary-container/20"
                : "border-outline-variant/40 text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

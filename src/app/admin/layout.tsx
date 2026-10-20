import { requireRoleForPage } from "@/lib/session";
import AdminNav from "@/components/AdminNav";
import SignOutButton from "@/components/SignOutButton";

// Server-enforced authorization gate for every /admin/* route. Non-admins are
// redirected to their own portal.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRoleForPage(["ADMIN"], "/admin");
  return (
    <div className="min-h-screen bg-background text-on-surface font-body">
      <header className="border-b border-outline-variant/30 bg-surface-container-lowest">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_10px_#ff2d78]" />
            <span className="font-headline font-bold text-base tracking-wider text-on-surface truncate">
              VERITAS ACADEMIA
            </span>
            <span className="ml-2 text-[10px] font-label tracking-widest text-secondary uppercase hidden sm:inline">
              Admin • Application Review
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs text-on-surface-variant font-label hidden sm:inline">
              Administrator
            </span>
            <SignOutButton />
          </div>
        </div>
        <AdminNav />
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

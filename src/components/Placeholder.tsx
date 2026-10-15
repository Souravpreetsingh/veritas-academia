import Shell from "@/components/Shell";
import { navFor } from "@/lib/nav";

/**
 * Keeps every sidebar link alive: routes that don't yet have a designed screen
 * render this panel instead of a 404.
 */
export default function Placeholder({
  persona,
  route,
  group,
}: {
  persona: "instructor" | "student";
  route: string;
  group?: string;
}) {
  const items = navFor(persona).flatMap((s) => s.items);
  const item = items.find((i) => i.route === route);
  const label = item?.label ?? route.split("/").filter(Boolean).pop() ?? "Screen";

  return (
    <Shell persona={persona} label={label} group={group ?? item?.path ?? ""}>
      <section className="flex flex-col items-center justify-center gap-6 py-24 text-center">
        <div className="w-16 h-16 rounded-2xl bg-primary-container/40 border border-primary/40 flex items-center justify-center shadow-[0_0_24px_rgba(255,45,120,0.25)]">
          <span className="material-symbols-outlined text-primary text-3xl">{item?.icon ?? "construction"}</span>
        </div>
        <div className="space-y-2 max-w-md">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded bg-surface-container-highest text-[10px] font-label font-bold tracking-widest uppercase text-secondary neon-text-cyan">
            Screen pending
          </div>
          <h1 className="text-3xl font-headline font-bold text-on-surface tracking-tight">{label}</h1>
          <p className="text-sm font-body text-on-surface-variant leading-relaxed">
            The sidebar entry is wired up and ready — this workspace screen simply hasn&apos;t been designed
            yet. Drop its code in and it will slot straight into the shell.
          </p>
        </div>
        <div className="font-mono text-xs text-on-surface-variant/60">{route}</div>
      </section>
    </Shell>
  );
}

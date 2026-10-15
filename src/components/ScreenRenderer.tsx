import Shell from "@/components/Shell";
import ScriptRunner from "@/components/ScriptRunner";
import type { ScreenDef } from "@/screens/manifest";
import { getScreen, getScript } from "@/screens/registry";

/**
 * Renders a generated Stitch screen inside the shared portal shell (or, for
 * the public marketing site, as a bare page that carries its own markup).
 */
export default function ScreenRenderer({ screen }: { screen: ScreenDef }) {
  const html = getScreen(screen.id);
  const script = getScript(screen.id);

  const content = <div dangerouslySetInnerHTML={{ __html: html }} />;
  const runner = <ScriptRunner code={script} />;

  if (screen.persona === "public") {
    return (
      <div className={screen.mainClassName}>
        {content}
        {runner}
      </div>
    );
  }

  return (
    <Shell
      persona={screen.persona}
      label={screen.label}
      group={screen.group}
      mainClassName={screen.mainClassName}
    >
      {content}
      {runner}
    </Shell>
  );
}

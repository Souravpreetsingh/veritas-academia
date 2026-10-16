import Placeholder from "@/components/Placeholder";
import ScreenRenderer from "@/components/ScreenRenderer";
import DocumentUploadEnhancer from "@/components/DocumentUploadEnhancer";
import { SCREENS, byRoute } from "@/screens/manifest";

const PREFIX = "/student";

const toParams = (route: string) => {
  const rest = route.slice(PREFIX.length);
  return { path: rest.split("/").filter(Boolean) };
};

export const dynamicParams = true;

export function generateStaticParams() {
  return SCREENS.filter((s) => s.persona === "student").map((s) => toParams(s.route));
}

export default async function StudentPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  const route = PREFIX + (path.length ? "/" + path.join("/") : "");

  const screen = byRoute(route);
  if (screen) {
    return (
      <>
        <ScreenRenderer screen={screen} />
        {screen.id === "student-document-upload" ? <DocumentUploadEnhancer /> : null}
      </>
    );
  }

  return <Placeholder persona="student" route={route} />;
}

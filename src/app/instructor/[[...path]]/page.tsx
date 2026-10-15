import Placeholder from "@/components/Placeholder";
import ScreenRenderer from "@/components/ScreenRenderer";
import { SCREENS, byRoute } from "@/screens/manifest";

const PREFIX = "/instructor";

const toParams = (route: string) => {
  const rest = route.slice(PREFIX.length);
  return { path: rest.split("/").filter(Boolean) };
};

export const dynamicParams = true;

export function generateStaticParams() {
  return SCREENS.filter((s) => s.persona === "instructor").map((s) => toParams(s.route));
}

export default async function InstructorPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  const route = PREFIX + (path.length ? "/" + path.join("/") : "");

  const screen = byRoute(route);
  if (screen) return <ScreenRenderer screen={screen} />;

  return <Placeholder persona="instructor" route={route} />;
}

import ScreenRenderer from "@/components/ScreenRenderer";
import { byRoute } from "@/screens/manifest";

export default function HomePage() {
  const screen = byRoute("/");
  if (!screen) return null;
  return <ScreenRenderer screen={screen} />;
}

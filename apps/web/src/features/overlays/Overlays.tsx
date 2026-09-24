import { type ReactNode, Suspense } from "react";
import { ArtifactViewer, CommandPalette, QuickSwitcher, SettingsModal } from "../../app/lazy";
import { useUiStore } from "../../state/ui-store";
import { ConfirmDialog } from "./ConfirmDialog";

export function Overlays() {
  const overlay = useUiStore((s) => s.overlay);
  if (!overlay) return null;
  let content: ReactNode;
  switch (overlay.kind) {
    case "palette":
      content = <CommandPalette />;
      break;
    case "switcher":
      content = <QuickSwitcher />;
      break;
    case "settings":
      content = <SettingsModal section={overlay.section} />;
      break;
    case "artifact":
      content = <ArtifactViewer threadId={overlay.threadId} artifactId={overlay.artifactId} />;
      break;
    case "confirm":
      content = <ConfirmDialog request={overlay.request} />;
      break;
  }
  return <Suspense fallback={null}>{content}</Suspense>;
}

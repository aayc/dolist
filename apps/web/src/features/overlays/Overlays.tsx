import { type ReactNode, Suspense } from "react";
import {
  ArtifactViewer,
  CommandPalette,
  NewRoutineDialog,
  QuickSwitcher,
  SettingsModal,
  VaultSwitchOverlay,
} from "../../app/lazy";
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
    case "new-routine":
      content = <NewRoutineDialog {...(overlay.draft ? { draft: overlay.draft } : {})} />;
      break;
    case "vault-switch":
      content = <VaultSwitchOverlay path={overlay.path} restart={overlay.restart} />;
      break;
  }
  return <Suspense fallback={null}>{content}</Suspense>;
}

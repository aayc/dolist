import { AgentLocationSection } from "./AgentLocationSection";
import { MachineSection } from "./MachineSection";
import type { GoToSection } from "./parts";
import { SyncSection } from "./SyncSection";
import "../../../styles/remote.css";

/** The Settings sections about where the agent runs, other devices and remote access. */
export const REMOTE_SECTIONS = ["location", "machine", "sync"] as const;
export type RemoteSectionKey = (typeof REMOTE_SECTIONS)[number];

/** Settings for this device's place among the vault's devices (a chunk of its own). */
export function RemoteSection({ section, go }: { section: RemoteSectionKey; go: GoToSection }) {
  switch (section) {
    case "location":
      return <AgentLocationSection go={go} />;
    case "machine":
      return <MachineSection go={go} />;
    case "sync":
      return <SyncSection />;
  }
}

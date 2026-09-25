import { AgentLocationSection } from "./AgentLocationSection";
import type { GoToSection } from "./parts";
import "../../../styles/remote.css";

/** The Settings sections about where the agent runs, other devices and remote access. */
export const REMOTE_SECTIONS = ["location"] as const;
export type RemoteSectionKey = (typeof REMOTE_SECTIONS)[number];

/** Settings for this device's place among the vault's devices (a chunk of its own). */
export function RemoteSection({ section, go }: { section: RemoteSectionKey; go: GoToSection }) {
  switch (section) {
    case "location":
      return <AgentLocationSection go={go} />;
  }
}

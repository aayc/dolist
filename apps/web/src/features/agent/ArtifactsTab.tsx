import type { ArtifactMeta } from "@ddl/core";
import { useAgentStore } from "../../state/agent-store";
import { ArtifactCard } from "./ArtifactCard";

const NONE: readonly ArtifactMeta[] = [];

export function ArtifactsTab({ threadId }: { threadId: string }) {
  const artifacts = useAgentStore((s) => s.details[threadId]?.artifacts ?? NONE);
  if (artifacts.length === 0) {
    return (
      <div className="tab-empty">No artifacts yet. Files the agent produces show up here.</div>
    );
  }
  return (
    <div className="artifact-list" data-testid="artifact-list">
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} threadId={threadId} artifactId={artifact.id} />
      ))}
    </div>
  );
}

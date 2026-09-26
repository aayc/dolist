import type { ArtifactKind, ArtifactMeta } from "@ddl/core";
import { formatBytes } from "@ddl/core";
import { Braces, File, FileCode, FileText, Globe, Image, type LucideIcon } from "lucide-react";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";

export const ARTIFACT_ICONS: Record<ArtifactKind, LucideIcon> = {
  markdown: FileText,
  code: FileCode,
  html: Globe,
  image: Image,
  json: Braces,
  text: FileText,
  file: File,
};

export function artifactKindLabel(meta: Pick<ArtifactMeta, "kind" | "language">): string {
  if (meta.kind === "code") return meta.language ? meta.language : "Code";
  if (meta.kind === "json") return "JSON";
  if (meta.kind === "html") return "HTML";
  return meta.kind.charAt(0).toUpperCase() + meta.kind.slice(1);
}

export function ArtifactCard({
  threadId,
  artifactId,
  className,
}: {
  threadId: string;
  artifactId: string;
  className?: string;
}) {
  const meta = useAgentStore((s) =>
    s.details[threadId]?.artifacts.find((a) => a.id === artifactId),
  );
  const Icon = meta ? ARTIFACT_ICONS[meta.kind] : File;
  return (
    <button
      type="button"
      className={className ? `artifact-card ${className}` : "artifact-card"}
      data-testid="artifact-card"
      data-tooltip={meta?.title}
      data-tooltip-overflow=".artifact-card-title"
      onClick={() => ui.openOverlay({ kind: "artifact", threadId, artifactId })}
    >
      <Icon size={18} className="artifact-card-icon" aria-hidden="true" />
      <span className="artifact-card-text">
        <span className="artifact-card-title">{meta?.title ?? "Artifact"}</span>
        <span className="artifact-card-meta">
          {meta ? `${artifactKindLabel(meta)} · ${formatBytes(meta.size)}` : "Loading…"}
        </span>
      </span>
    </button>
  );
}

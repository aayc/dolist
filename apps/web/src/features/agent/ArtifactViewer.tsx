import type { ArtifactKind, ArtifactMeta } from "@ddl/core";
import { errorMessage } from "@ddl/core";
import { Download, File, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactContent } from "../../api/client";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { Modal } from "../overlays/Modal";
import { ARTIFACT_ICONS, artifactKindLabel } from "./ArtifactCard";
import { Markdown } from "./Markdown";
import { useMarkdownLinks } from "./markdown-links";
import "../../styles/agent.css";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: ArtifactContent; text: string | null; url: string | null };

const EXTENSIONS: Record<ArtifactKind, string> = {
  markdown: "md",
  code: "txt",
  html: "html",
  image: "png",
  json: "json",
  text: "txt",
  file: "bin",
};

function kindFromMime(mimeType: string): ArtifactKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/html") return "html";
  if (mimeType === "application/json") return "json";
  if (mimeType.startsWith("text/")) return "text";
  return "file";
}

function fileName(meta: ArtifactMeta | undefined, kind: ArtifactKind, mimeType: string): string {
  const base = (meta?.title ?? "artifact").replace(/[\\/:*?"<>|]+/g, "-").trim() || "artifact";
  const ext = kind === "image" ? (mimeType.split("/")[1] ?? "png") : EXTENSIONS[kind];
  return `${base}.${ext}`;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ArtifactViewer({ threadId, artifactId }: { threadId: string; artifactId: string }) {
  const { client } = useServices();
  const meta = useAgentStore((s) =>
    s.details[threadId]?.artifacts.find((a) => a.id === artifactId),
  );
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const bodyRef = useRef<HTMLDivElement>(null);
  useMarkdownLinks(bodyRef, threadId, () => ui.closeOverlay());

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    client.getArtifact(threadId, artifactId).then(
      async (content) => {
        const binary =
          content.mimeType.startsWith("image/") || kindFromMime(content.mimeType) === "file";
        const text = binary ? null : await content.blob.text();
        if (content.mimeType.startsWith("image/")) url = URL.createObjectURL(content.blob);
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setLoaded({ status: "ready", content, text, url });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: "error", message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, threadId, artifactId]);

  const kind: ArtifactKind =
    meta?.kind ?? (loaded.status === "ready" ? kindFromMime(loaded.content.mimeType) : "file");
  const Icon = ARTIFACT_ICONS[kind] ?? File;
  const title = meta?.title ?? "Artifact";

  return (
    <Modal label={title} className="artifact-viewer" testId="artifact-viewer">
      <header className="artifact-viewer-header" data-tooltip-placement="bottom">
        <Icon size={16} aria-hidden="true" />
        <h2 className="artifact-viewer-title" data-tooltip={title} data-tooltip-overflow="">
          {title}
        </h2>
        <span className="chip">{meta ? artifactKindLabel(meta) : kind}</span>
        <span className="artifact-viewer-spacer" />
        <IconButton
          icon={Download}
          label="Download"
          disabled={loaded.status !== "ready"}
          onClick={() => {
            if (loaded.status === "ready") {
              download(loaded.content.blob, fileName(meta, kind, loaded.content.mimeType));
            }
          }}
          data-testid="artifact-download"
        />
        <IconButton
          icon={X}
          label="Close"
          command="overlay:close"
          onClick={() => ui.closeOverlay()}
        />
      </header>
      <div
        ref={bodyRef}
        className="artifact-viewer-body"
        data-testid="artifact-body"
        data-kind={kind}
      >
        {loaded.status === "loading" ? <div className="thread-loading" aria-busy="true" /> : null}
        {loaded.status === "error" ? <div className="search-error">{loaded.message}</div> : null}
        {loaded.status === "ready" ? (
          <ArtifactBody kind={kind} loaded={loaded} meta={meta} title={title} />
        ) : null}
      </div>
    </Modal>
  );
}

function ArtifactBody({
  kind,
  loaded,
  meta,
  title,
}: {
  kind: ArtifactKind;
  loaded: Extract<Loaded, { status: "ready" }>;
  meta: ArtifactMeta | undefined;
  title: string;
}) {
  const text = loaded.text ?? "";
  switch (kind) {
    case "markdown":
      return <Markdown source={text} className="artifact-markdown" />;
    case "code":
      return (
        <div className="code-block">
          <span className="code-lang">{meta?.language ?? "code"}</span>
          <pre>
            <code>{text}</code>
          </pre>
        </div>
      );
    case "html":
      // Sandboxed with no permissions: no scripts, forms, popups or same-origin access.
      return <iframe className="artifact-html" sandbox="" srcDoc={text} title={title} />;
    case "image":
      return loaded.url ? <img className="artifact-image" src={loaded.url} alt={title} /> : null;
    case "json":
      return <pre className="artifact-pre">{prettyJson(text)}</pre>;
    case "text":
      return <pre className="artifact-pre">{text}</pre>;
    default:
      return (
        <div className="tab-empty">This file can't be previewed. Use Download to save it.</div>
      );
  }
}

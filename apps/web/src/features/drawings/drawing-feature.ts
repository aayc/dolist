import {
  drawingLinkTarget,
  emptyDrawingScene,
  formatDrawingEmbed,
  isDrawingPath,
  isDrawingTarget,
  newDrawingName,
  resolveWikiLink,
  serializeDrawingFile,
  uniqueDrawingPath,
  type VaultChange,
} from "@ddl/core";
import type { EmbedRenderer } from "@ddl/editor";
import { DrawingEmbedView } from "./drawing-embed";
import { DrawingOverlay } from "./drawing-overlay";
import { Drawings, type DrawingsClient } from "./drawing-store";
import { loadExcalidraw } from "./excalidraw-loader";
import { DrawingRenders } from "./render-cache";

/** A new drawing's embed: floated right with the text wrapping around it, 360 px wide. */
export const NEW_DRAWING_EMBED = { width: 360, placement: "right-wrap" } as const;

export interface DrawingFeatureDeps {
  client: DrawingsClient;
  /** The vault's file paths. */
  files(): readonly string[];
  onFilesChanged(listener: () => void): () => void;
  onError(title: string, error: unknown): void;
}

/**
 * Drawings in the app: the files (`Drawings`), their static renders, the embed renderer the
 * editor draws `![[….excalidraw]]` with, and in-place editing (one drawing at a time).
 */
export class DrawingFeature {
  readonly drawings: Drawings;
  readonly renders: DrawingRenders;
  readonly renderer: EmbedRenderer;
  private readonly deps: DrawingFeatureDeps;
  private editing: { view: DrawingEmbedView; overlay: DrawingOverlay } | null = null;

  constructor(deps: DrawingFeatureDeps) {
    this.deps = deps;
    this.drawings = new Drawings(deps.client);
    this.renders = new DrawingRenders(async (scene) =>
      (await loadExcalidraw()).renderDrawing(scene),
    );
    const context = {
      drawings: this.drawings,
      renders: this.renders,
      resolve: (target: string) => resolveWikiLink(target, deps.files()),
      onFilesChanged: deps.onFilesChanged,
      edit: (view: DrawingEmbedView) => this.edit(view),
      gone: (view: DrawingEmbedView) => {
        if (this.editing?.view === view) void this.editing.overlay.close("gone");
      },
    };
    this.renderer = {
      kind: "drawing",
      matches: isDrawingTarget,
      mount: (host) => new DrawingEmbedView(host, context),
    };
  }

  /** A drawing is being edited in place. */
  get isEditing(): boolean {
    return this.editing !== null;
  }

  /** Ends in-place editing (saving first). */
  async finishEditing(): Promise<void> {
    await this.editing?.overlay.close("done");
  }

  /** Saves what the drawing being edited has pending. */
  async flush(): Promise<void> {
    await this.editing?.overlay.flush();
  }

  private edit(view: DrawingEmbedView): void {
    const path = view.path;
    if (!path) return;
    if (this.editing?.view === view && !this.editing.overlay.isClosing) return;
    void this.editing?.overlay.close("done");
    view.setEditing(true);
    const overlay = new DrawingOverlay({
      host: view.host,
      path,
      drawings: this.drawings,
      previewSettled: () => view.settled(),
      onError: (error) => this.deps.onError("Couldn't save the drawing", error),
      onClosed: (reason) => {
        view.setEditing(false);
        if (this.editing?.overlay === overlay) this.editing = null;
        if (reason === "escape" || reason === "done") view.host.select();
      },
    });
    this.editing = { view, overlay };
  }

  /** A new, empty drawing file (`Excalidraw/Drawing <date>.excalidraw.md`) and how to embed it. */
  async create(): Promise<{ path: string; embed: string }> {
    const files = new Set(this.deps.files());
    const path = uniqueDrawingPath(newDrawingName(), (candidate) => files.has(candidate));
    const doc = await this.drawings.write(path, serializeDrawingFile(emptyDrawingScene()), null);
    const target = drawingLinkTarget(doc.path, [...files, doc.path]);
    return { path: doc.path, embed: formatDrawingEmbed({ target, ...NEW_DRAWING_EMBED }) };
  }

  handleVaultChange(change: VaultChange): void {
    if (!isDrawingPath(change.path)) return;
    if (change.kind === "deleted") this.drawings.handleRemoteDelete(change.path);
    else void this.drawings.handleRemoteChange(change.path, change.version);
  }
}

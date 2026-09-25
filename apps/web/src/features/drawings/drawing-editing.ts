import type { DrawingElement } from "@ddl/core";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DrawingEditorMount, DrawingView } from "./DrawingEditor";
import { type DrawingEditorPort, DrawingSession } from "./drawing-session";
import type { Drawings } from "./drawing-store";
import { type ExcalidrawLib, loadExcalidraw } from "./excalidraw-loader";
import type { DrawingTheme } from "./render-cache";

/** The app's theme, which Excalidraw follows. */
export function appTheme(): DrawingTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function onAppThemeChange(listener: (theme: DrawingTheme) => void): () => void {
  const observer = new MutationObserver(() => listener(appTheme()));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export interface OpenDrawingOptions {
  drawings: Drawings;
  path: string;
  /** Excalidraw fills it; the caller sizes it. */
  container: HTMLElement;
  /** Where the view starts, given the drawing (in place over its preview); fitted without. */
  view?(elements: readonly DrawingElement[], lib: ExcalidrawLib): DrawingView | undefined;
  /** Every change in the editor, including the view (after the session saw it). */
  onChange?(api: ExcalidrawImperativeAPI): void;
  onError(error: unknown): void;
}

function port(api: ExcalidrawImperativeAPI, lib: ExcalidrawLib): DrawingEditorPort {
  return {
    scene: () => ({
      elements: api.getSceneElementsIncludingDeleted() as unknown as DrawingElement[],
      appState: api.getAppState() as unknown as Record<string, unknown>,
      files: api.getFiles() as unknown as ReturnType<DrawingEditorPort["scene"]>["files"],
    }),
    replace: (elements, files) => {
      api.addFiles(Object.values(files) as unknown as Parameters<typeof api.addFiles>[0]);
      api.updateScene({
        elements: elements as unknown as Parameters<typeof api.updateScene>[0]["elements"],
        captureUpdate: lib.CaptureUpdateAction.NEVER,
      });
    },
    editing: () => {
      const state = api.getAppState();
      const ids = [
        state.editingTextElement?.id,
        state.newElement?.id,
        state.multiElement?.id,
        state.resizingElement?.id,
        state.editingLinearElement?.elementId,
      ];
      return new Set(ids.filter((id): id is string => typeof id === "string"));
    },
  };
}

/**
 * Excalidraw editing one drawing file: loads the library and the file, mounts the editor and
 * connects it to a `DrawingSession` (saving, merging). Used in place over a note and as the pane
 * of an opened drawing.
 */
export class DrawingEditing {
  readonly session: DrawingSession;
  readonly lib: ExcalidrawLib;
  private readonly mount: DrawingEditorMount;
  private readonly stopTheme: () => void;
  private apiValue: ExcalidrawImperativeAPI | null = null;
  private attached = false;
  private disposed = false;

  private constructor(options: OpenDrawingOptions, lib: ExcalidrawLib, session: DrawingSession) {
    this.lib = lib;
    this.session = session;
    const scene = session.initialScene();
    const view = options.view?.(scene.elements, lib);
    this.mount = lib.mountDrawingEditor(options.container, {
      scene,
      theme: appTheme(),
      ...(view ? { view } : {}),
      onReady: (api) => {
        this.apiValue = api;
      },
      onChange: (elements, appState) => {
        const api = this.apiValue;
        if (!api || this.disposed) return;
        // The first change after loading is the file as Excalidraw shows it: not an edit.
        if (!this.attached) {
          if (appState.isLoading) return;
          this.attached = true;
          session.attach(port(api, lib));
        }
        session.changed(
          elements as unknown as DrawingElement[],
          appState as unknown as Record<string, unknown>,
        );
        options.onChange?.(api);
      },
    });
    this.stopTheme = onAppThemeChange((theme) => this.mount.setTheme(theme));
  }

  static async open(options: OpenDrawingOptions): Promise<DrawingEditing> {
    const [lib, doc] = await Promise.all([loadExcalidraw(), options.drawings.load(options.path)]);
    const session = new DrawingSession({
      drawings: options.drawings,
      doc,
      onError: options.onError,
    });
    return new DrawingEditing(options, lib, session);
  }

  get api(): ExcalidrawImperativeAPI | null {
    return this.apiValue;
  }

  /** Saves what's pending. */
  flush(): Promise<void> {
    return this.session.flush();
  }

  /** Saves, then unmounts Excalidraw. */
  async close(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.session.close();
    } finally {
      this.dispose();
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTheme();
    this.mount.unmount();
  }
}

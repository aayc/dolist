/**
 * Excalidraw itself, mounted in a container the caller sizes (a drawing's box over the note, or a
 * whole pane). In the lazily loaded chunk, with `excalidraw-module.ts`.
 */
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { DrawingTheme } from "./render-cache";
import type { EditorScene } from "./scene";

/** Where the view starts: Excalidraw's zoom and scroll (scene units), e.g. over the preview. */
export interface DrawingView {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

export interface DrawingEditorProps {
  scene: EditorScene;
  theme: DrawingTheme;
  /** Without it, the drawing is fitted to the container. */
  view?: DrawingView;
  onChange(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles): void;
  onReady(api: ExcalidrawImperativeAPI): void;
}

export interface DrawingEditorMount {
  setTheme(theme: DrawingTheme): void;
  unmount(): void;
}

const UI_OPTIONS = {
  canvasActions: {
    export: false as const,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: null,
  },
};

function DrawingEditor({ scene, theme, view, onChange, onReady }: DrawingEditorProps) {
  // Excalidraw reads its initial data once; later changes go through its API.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial data only
  const initialData = useMemo<ExcalidrawInitialDataState>(
    () => ({
      elements: scene.elements as unknown as ExcalidrawElement[],
      files: scene.files as unknown as BinaryFiles,
      appState: {
        ...(scene.appState as Partial<AppState>),
        ...(view
          ? {
              zoom: { value: view.zoom as AppState["zoom"]["value"] },
              scrollX: view.scrollX,
              scrollY: view.scrollY,
            }
          : {}),
      },
      scrollToContent: !view,
    }),
    [],
  );
  return (
    <Excalidraw
      initialData={initialData}
      excalidrawAPI={onReady}
      onChange={onChange}
      theme={theme}
      langCode="en"
      aiEnabled={false}
      autoFocus
      detectScroll
      handleKeyboardGlobally={false}
      UIOptions={UI_OPTIONS}
    >
      <MainMenu>
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
    </Excalidraw>
  );
}

export function mountDrawingEditor(
  container: HTMLElement,
  props: DrawingEditorProps,
): DrawingEditorMount {
  const root = createRoot(container);
  let current = props;
  const render = () =>
    root.render(
      <StrictMode>
        <DrawingEditor {...current} />
      </StrictMode>,
    );
  render();
  return {
    setTheme(theme) {
      if (theme === current.theme) return;
      current = { ...current, theme };
      render();
    },
    unmount: () => root.unmount(),
  };
}

import { ClipboardPaste, Copy, ExternalLink, PencilRuler, Scissors, Shapes } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { installKeystrokeSampler } from "../../perf/perf";
import { toast } from "../../state/toast-store";

interface Menu {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Hosts the single editor instance. It never re-renders on note switches or keystrokes. Its context
 * menu (Shift+right-click keeps the browser's) has the clipboard, Insert drawing, and for a drawing,
 * Edit and Open.
 */
export function EditorHost({ hidden = false }: { hidden?: boolean }) {
  const { workspace, commands } = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    workspace.mountEditor(element);
    const stopSampling = installKeystrokeSampler(element);
    return () => {
      stopSampling();
      workspace.unmountEditor();
    };
  }, [workspace]);

  const onContextMenu = (event: React.MouseEvent) => {
    const target = event.target as Element;
    if (event.shiftKey || !target.closest(".cm-content")) return;
    event.preventDefault();
    const { editor } = workspace;
    const items: MenuItem[] = [];
    const drawing = target.closest<HTMLElement>(".cm-ddl-embed-drawing");
    const path = drawing?.querySelector<HTMLElement>(".drawing-embed")?.dataset.path;
    if (drawing) {
      items.push({
        label: "Edit drawing",
        icon: PencilRuler,
        onSelect: () => drawing.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
      });
      if (path) {
        items.push({
          label: "Open drawing",
          icon: ExternalLink,
          onSelect: () => void workspace.openNote(path, { newTab: true }),
        });
      }
    } else {
      const selected = editor.selectedText();
      if (selected) {
        items.push(
          {
            label: "Cut",
            icon: Scissors,
            onSelect: () =>
              void navigator.clipboard
                .writeText(selected)
                .then(() => editor.replaceSelection("", "delete.cut"), clipboardProblem),
          },
          {
            label: "Copy",
            icon: Copy,
            onSelect: () => void navigator.clipboard.writeText(selected).catch(clipboardProblem),
          },
        );
      }
      items.push({
        label: "Paste",
        icon: ClipboardPaste,
        onSelect: () =>
          void navigator.clipboard
            .readText()
            .then((text) => editor.replaceSelection(text, "input.paste"), clipboardProblem),
      });
      if (commands.get("drawing:insert")?.when?.() !== false) {
        items.push({
          label: "Insert drawing",
          icon: Shapes,
          onSelect: () => void commands.run("drawing:insert"),
        });
      }
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <>
      <div
        ref={ref}
        className="editor-host"
        data-testid="editor-host"
        hidden={hidden}
        onContextMenu={onContextMenu}
      />
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} /> : null}
    </>
  );
}

function clipboardProblem(error: unknown): void {
  toast({
    kind: "error",
    title: "The clipboard isn't available",
    body: error instanceof Error ? error.message : String(error),
  });
}

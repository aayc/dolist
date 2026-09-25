import { useEffect, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { DrawingEditing } from "./drawing-editing";

/** An opened drawing file: Excalidraw over the whole pane, not the file's markdown. */
export function DrawingPane({ path }: { path: string }) {
  const { workspace } = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    setProblem(null);
    let editing: DrawingEditing | null = null;
    let closed = false;
    const feature = workspace.drawingFeature;
    feature.drawings
      .load(path)
      .then((doc) => {
        if (closed) return null;
        if (!doc.parsed.readable) {
          setProblem("This drawing can't be read, so it's left as it is.");
          return null;
        }
        return DrawingEditing.open({
          drawings: feature.drawings,
          path,
          container,
          onError: (error) => workspace.reportDrawingError(error),
        });
      })
      .then(
        (opened) => {
          if (!opened) return;
          if (closed) void opened.close();
          else {
            editing = opened;
            workspace.setOpenDrawing(opened);
          }
        },
        () => setProblem("This drawing couldn't be opened."),
      );
    return () => {
      closed = true;
      if (editing) {
        workspace.setOpenDrawing(null);
        void editing.close();
      }
    };
  }, [path, workspace]);

  return (
    <div className="drawing-pane" data-testid="drawing-pane">
      {problem ? <p className="drawing-pane-problem">{problem}</p> : null}
      <div ref={ref} className="drawing-pane-canvas" hidden={problem !== null} />
    </div>
  );
}

import { useLayoutEffect, useRef } from "react";
import { useServices } from "../../app/services";
import { installKeystrokeSampler } from "../../perf/perf";

/** Hosts the single editor instance. It never re-renders on note switches or keystrokes. */
export function EditorHost() {
  const { workspace } = useServices();
  const ref = useRef<HTMLDivElement>(null);

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

  return <div ref={ref} className="editor-host" data-testid="editor-host" />;
}

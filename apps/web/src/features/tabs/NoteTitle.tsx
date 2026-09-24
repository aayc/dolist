import { dirname, stem } from "@ddl/core";
import { useEffect, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { ui, useUiStore } from "../../state/ui-store";

/** Inline-editable title (the file name). Enter/blur renames; Escape reverts. Keyed by path. */
export function NoteTitle({ path }: { path: string }) {
  const { workspace } = useServices();
  const original = stem(path);
  const [value, setValue] = useState(original);
  const ref = useRef<HTMLInputElement>(null);
  const committing = useRef(false);
  const focusRequested = useUiStore((s) => s.titleFocus === path);

  useEffect(() => {
    if (!focusRequested) return;
    ref.current?.focus();
    ref.current?.select();
    ui.set({ titleFocus: null });
  }, [focusRequested]);

  const commit = async () => {
    if (committing.current) return;
    const next = value.trim();
    if (!next || next === original) {
      setValue(original);
      return;
    }
    committing.current = true;
    const ok = await workspace.renameNoteTitle(path, next);
    committing.current = false;
    if (!ok) setValue(original);
  };

  const folder = dirname(path);
  return (
    <div className="note-title-row">
      {folder ? <div className="note-breadcrumb">{folder.split("/").join(" / ")}</div> : null}
      <input
        ref={ref}
        className="note-title"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit().then(() => workspace.editor.focus());
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setValue(original);
            workspace.editor.focus();
          }
        }}
        spellCheck={false}
        autoComplete="off"
        aria-label="Note title"
        data-testid="note-title"
      />
    </div>
  );
}

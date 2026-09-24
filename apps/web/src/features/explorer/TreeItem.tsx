import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useRef } from "react";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { useTabsStore } from "../../state/tabs-store";
import { ui, useUiStore } from "../../state/ui-store";
import type { TreeNode } from "./tree";

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  onMenu(x: number, y: number, path: string, kind: "file" | "folder"): void;
}

function moveFocus(from: HTMLElement, direction: 1 | -1): void {
  const tree = from.closest('[role="tree"]');
  if (!tree) return;
  const rows = [...tree.querySelectorAll<HTMLElement>(".tree-row")];
  rows[rows.indexOf(from) + direction]?.focus();
}

export const TreeItem = memo(function TreeItem({ node, depth, onMenu }: TreeItemProps) {
  const { workspace } = useServices();
  const isFolder = node.kind === "folder";
  const expanded = useUiStore((s) => isFolder && Boolean(s.expanded[node.path]));
  const renaming = useUiStore((s) => s.renaming === node.path);
  const active = useTabsStore((s) => s.active === node.path);

  const activate = (newTab: boolean) => {
    if (isFolder) ui.setExpanded(node.path, !expanded);
    else void workspace.openNote(node.path, { newTab });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        activate(event.metaKey || event.ctrlKey);
        break;
      case "F2":
        event.preventDefault();
        ui.set({ renaming: node.path });
        break;
      case "Delete":
      case "Backspace":
        if (event.key === "Backspace" && !event.metaKey) break;
        event.preventDefault();
        workspace.requestDelete(node.path);
        break;
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        moveFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
        break;
      case "ArrowRight":
        if (isFolder && !expanded) ui.setExpanded(node.path, true);
        break;
      case "ArrowLeft":
        if (isFolder && expanded) ui.setExpanded(node.path, false);
        break;
    }
  };

  // Flat ARIA tree (aria-level) so every row is a focusable treeitem.
  return (
    <>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={isFolder ? expanded : undefined}
        aria-selected={active}
        className={cx("tree-row", isFolder ? "is-folder" : "is-file", active && "is-active")}
        style={{ paddingInlineStart: 8 + depth * 16 }}
        tabIndex={0}
        title={node.path}
        data-testid="explorer-item"
        data-path={node.path}
        data-kind={node.kind}
        onClick={(event) => !renaming && activate(event.metaKey || event.ctrlKey)}
        onAuxClick={(event) => {
          if (event.button === 1 && !isFolder) void workspace.openNote(node.path, { newTab: true });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(event.clientX, event.clientY, node.path, node.kind);
        }}
        onKeyDown={onKeyDown}
      >
        {isFolder ? (
          <ChevronRight
            size={14}
            className={cx("tree-chevron", expanded && "is-open")}
            aria-hidden="true"
          />
        ) : (
          <span className="tree-chevron-spacer" />
        )}
        {renaming ? <RenameInput node={node} /> : <span className="tree-name">{node.name}</span>}
      </div>
      {isFolder && expanded
        ? node.children.map((child) => (
            <TreeItem key={child.path} node={child} depth={depth + 1} onMenu={onMenu} />
          ))
        : null}
    </>
  );
});

function RenameInput({ node }: { node: TreeNode }) {
  const { workspace } = useServices();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = async (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value.trim() ?? "";
    ui.set({ renaming: null });
    if (commit && value && value !== node.name) await workspace.renameEntry(node.path, value);
  };

  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={node.name}
      aria-label={`Rename ${node.name}`}
      data-testid="explorer-rename"
      onClick={(event) => event.stopPropagation()}
      onBlur={() => void finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          void finish(false);
        }
      }}
    />
  );
}

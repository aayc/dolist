import { ChevronsDownUp, ExternalLink, FilePlus, FolderPlus, Pencil, Trash } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { IconButton } from "../../components/IconButton";
import { ui, useUiStore } from "../../state/ui-store";
import { useVaultStore } from "../../state/vault-store";
import { TreeItem } from "./TreeItem";
import { buildTree, type TreeNode } from "./tree";

interface MenuState {
  x: number;
  y: number;
  path: string | null;
  kind: "file" | "folder" | null;
}

/** `.tree-row`'s height: only the rows in view (and a margin) are rendered. */
const ROW_HEIGHT = 28;
const OVERSCAN = 20;

function visibleRows(
  nodes: readonly TreeNode[],
  expanded: Readonly<Record<string, true>>,
  depth = 0,
  out: Array<{ node: TreeNode; depth: number }> = [],
) {
  for (const node of nodes) {
    out.push({ node, depth });
    if (expanded[node.path]) visibleRows(node.children, expanded, depth + 1, out);
  }
  return out;
}

function useRowWindow(ref: RefObject<HTMLDivElement | null>) {
  const [range, setRange] = useState({ start: 0, end: 2 * OVERSCAN });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN);
      const end = Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + OVERSCAN;
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    // Also reports the first size, once laid out.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [ref]);
  return range;
}

export function FileExplorer() {
  const { workspace } = useServices();
  const entries = useVaultStore((s) => s.entries);
  const vaultName = useVaultStore((s) => s.vaultName);
  const expanded = useUiStore((s) => s.expanded);
  const tree = useMemo(() => buildTree(entries.values()), [entries]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { start, end } = useRowWindow(scrollRef);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = useCallback(
    (x: number, y: number, path: string | null, kind: MenuState["kind"]) => {
      setMenu({ x, y, path, kind });
    },
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems = (state: MenuState): MenuItem[] => {
    const { path, kind } = state;
    if (path === null || kind === null) {
      return [
        { label: "New note", icon: FilePlus, onSelect: () => void workspace.createNote() },
        { label: "New folder", icon: FolderPlus, onSelect: () => void workspace.createFolder() },
      ];
    }
    const common: MenuItem[] = [
      { label: "Rename", icon: Pencil, onSelect: () => ui.set({ renaming: path }) },
      { label: "Delete", icon: Trash, danger: true, onSelect: () => workspace.requestDelete(path) },
    ];
    if (kind === "folder") {
      return [
        {
          label: "New note",
          icon: FilePlus,
          onSelect: () => void workspace.createNote({ folder: path }),
        },
        {
          label: "New folder",
          icon: FolderPlus,
          onSelect: () => void workspace.createFolder(path),
        },
        ...common,
      ];
    }
    return [
      {
        label: "Open in new tab",
        icon: ExternalLink,
        onSelect: () => void workspace.openNote(path, { newTab: true }),
      },
      ...common,
    ];
  };

  return (
    <div className="explorer" data-testid="explorer">
      <div className="panel-header" data-tooltip-placement="bottom">
        <span className="panel-title" data-tooltip={vaultName} data-tooltip-overflow="">
          {vaultName || "Vault"}
        </span>
        <IconButton
          icon={FilePlus}
          command="note:new"
          onClick={() => void workspace.createNote()}
          data-testid="explorer-new-note"
        />
        <IconButton
          icon={FolderPlus}
          command="folder:new"
          onClick={() => void workspace.createFolder()}
          data-testid="explorer-new-folder"
        />
        <IconButton
          icon={ChevronsDownUp}
          label="Collapse all"
          onClick={() => ui.set({ expanded: {} })}
        />
      </div>
      <div
        ref={scrollRef}
        className="explorer-tree"
        role="tree"
        aria-label="Files"
        onContextMenu={(event) => {
          if ((event.target as Element).closest(".tree-row")) return;
          event.preventDefault();
          openMenu(event.clientX, event.clientY, null, null);
        }}
      >
        <div
          style={{
            paddingTop: start * ROW_HEIGHT,
            paddingBottom: Math.max(0, rows.length - end) * ROW_HEIGHT,
          }}
        >
          {rows.slice(start, end).map(({ node, depth }) => (
            <TreeItem key={node.path} node={node} depth={depth} onMenu={openMenu} />
          ))}
        </div>
      </div>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />
      ) : null}
    </div>
  );
}

import { ChevronsDownUp, ExternalLink, FilePlus, FolderPlus, Pencil, Trash } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useServices } from "../../app/services";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { IconButton } from "../../components/IconButton";
import { ui } from "../../state/ui-store";
import { useVaultStore } from "../../state/vault-store";
import { TreeItem } from "./TreeItem";
import { buildTree } from "./tree";

interface MenuState {
  x: number;
  y: number;
  path: string | null;
  kind: "file" | "folder" | null;
}

export function FileExplorer() {
  const { workspace } = useServices();
  const entries = useVaultStore((s) => s.entries);
  const vaultName = useVaultStore((s) => s.vaultName);
  const tree = useMemo(() => buildTree(entries.values()), [entries]);
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
        className="explorer-tree"
        role="tree"
        aria-label="Files"
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          openMenu(event.clientX, event.clientY, null, null);
        }}
      >
        {tree.map((node) => (
          <TreeItem key={node.path} node={node} depth={0} onMenu={openMenu} />
        ))}
      </div>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />
      ) : null}
    </div>
  );
}

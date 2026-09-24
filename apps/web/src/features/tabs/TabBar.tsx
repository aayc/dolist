import { stem } from "@ddl/core";
import { PanelRight, Plus, X } from "lucide-react";
import { memo } from "react";
import { useServices } from "../../app/services";
import { hotkeyLabel } from "../../commands/labels";
import { IconButton } from "../../components/IconButton";
import { cx } from "../../lib/cx";
import { useNotesStore } from "../../state/notes-store";
import { useTabsStore } from "../../state/tabs-store";
import { ui, useUiStore } from "../../state/ui-store";

export function TabBar() {
  const { workspace, commands } = useServices();
  const tabs = useTabsStore((s) => s.tabs);
  const rightOpen = useUiStore((s) => s.rightOpen);
  return (
    <div className="tab-bar" data-testid="tab-bar">
      <div className="tab-list" role="tablist" aria-label="Open notes">
        {tabs.map((path) => (
          <Tab key={path} path={path} />
        ))}
      </div>
      <IconButton
        icon={Plus}
        label="New note"
        hotkey={hotkeyLabel(commands, "note:new")}
        onClick={() => void workspace.createNote()}
        className="tab-new"
        data-testid="tab-new"
      />
      <div className="tab-bar-spacer" />
      <IconButton
        icon={PanelRight}
        label="Toggle agent panel"
        hotkey={hotkeyLabel(commands, "panel:right")}
        active={rightOpen}
        onClick={() => ui.toggleRight()}
        data-testid="toggle-right-panel"
      />
    </div>
  );
}

const Tab = memo(function Tab({ path }: { path: string }) {
  const { workspace } = useServices();
  const active = useTabsStore((s) => s.active === path);
  const unsaved = useNotesStore((s) => {
    const state = s.saveState[path];
    return state === "dirty" || state === "saving" || state === "conflict" || state === "error";
  });
  const name = stem(path);
  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      className={cx("tab", active && "is-active")}
      title={path}
      data-testid="tab"
      data-path={path}
      onMouseDown={(event) => {
        if (event.button === 0) workspace.activateTab(path, event.timeStamp);
        else if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) workspace.closeTab(path);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          workspace.activateTab(path, event.timeStamp);
        }
      }}
    >
      <span className="tab-title">{name}</span>
      {unsaved ? (
        <span className="tab-unsaved" title="Unsaved changes">
          <span className="sr-only">Unsaved changes</span>
        </span>
      ) : null}
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${name}`}
        data-testid="tab-close"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          workspace.closeTab(path);
        }}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
});

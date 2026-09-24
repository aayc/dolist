import { CalendarDays, Files, Inbox, Search, Settings } from "lucide-react";
import { useServices } from "../../app/services";
import { hotkeyLabel } from "../../commands/labels";
import { IconButton } from "../../components/IconButton";
import { usePendingApprovalCount } from "../../state/agent-store";
import { ui, useUiStore } from "../../state/ui-store";

export function Ribbon() {
  const { workspace, commands } = useServices();
  const filesOpen = useUiStore((s) => s.leftOpen && s.leftView === "files");
  const searchOpen = useUiStore((s) => s.leftOpen && s.leftView === "search");
  const inboxOpen = useUiStore((s) => s.rightOpen && s.rightView.kind === "inbox");
  const pending = usePendingApprovalCount();

  return (
    <nav className="ribbon" aria-label="Ribbon">
      <IconButton
        icon={Files}
        label="Toggle file explorer"
        active={filesOpen}
        onClick={() => ui.toggleLeft("files")}
        data-testid="ribbon-files"
        size={18}
      />
      <IconButton
        icon={Search}
        label="Search vault"
        hotkey={hotkeyLabel(commands, "search:open")}
        active={searchOpen}
        onClick={() => (searchOpen ? ui.toggleLeft("search") : ui.focusSearch())}
        data-testid="ribbon-search"
        size={18}
      />
      <IconButton
        icon={CalendarDays}
        label="Open today's daily note"
        hotkey={hotkeyLabel(commands, "daily:today")}
        onClick={(event) => void workspace.openToday(event.timeStamp)}
        data-testid="ribbon-daily"
        size={18}
      />
      <IconButton
        icon={Inbox}
        label="Agent inbox"
        hotkey={hotkeyLabel(commands, "agent:inbox")}
        active={inboxOpen}
        badge={pending}
        onClick={() => ui.toggleInbox()}
        data-testid="ribbon-inbox"
        size={18}
      />
      <div className="ribbon-spacer" />
      <IconButton
        icon={Settings}
        label="Settings"
        hotkey={hotkeyLabel(commands, "settings:open")}
        onClick={() => ui.openOverlay({ kind: "settings", section: "general" })}
        data-testid="ribbon-settings"
        size={18}
      />
    </nav>
  );
}

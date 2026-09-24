import { CalendarDays, Files, Inbox, Search, Settings } from "lucide-react";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { usePendingApprovalCount } from "../../state/agent-store";
import { ui, useUiStore } from "../../state/ui-store";

export function Ribbon() {
  const { workspace } = useServices();
  const filesOpen = useUiStore((s) => s.leftOpen && s.leftView === "files");
  const searchOpen = useUiStore((s) => s.leftOpen && s.leftView === "search");
  const inboxOpen = useUiStore((s) => s.rightOpen && s.rightView.kind === "inbox");
  const pending = usePendingApprovalCount();

  return (
    <nav className="ribbon" aria-label="Ribbon" data-tooltip-placement="right">
      <IconButton
        icon={Files}
        command="panel:left"
        active={filesOpen}
        onClick={() => ui.toggleLeft("files")}
        data-testid="ribbon-files"
        size={18}
      />
      <IconButton
        icon={Search}
        command="search:open"
        active={searchOpen}
        onClick={() => (searchOpen ? ui.toggleLeft("search") : ui.focusSearch())}
        data-testid="ribbon-search"
        size={18}
      />
      <IconButton
        icon={CalendarDays}
        command="daily:today"
        onClick={(event) => void workspace.openToday(event.timeStamp)}
        data-testid="ribbon-daily"
        size={18}
      />
      <IconButton
        icon={Inbox}
        command="agent:inbox"
        active={inboxOpen}
        badge={pending}
        badgeLabel="to approve"
        onClick={() => ui.toggleInbox()}
        data-testid="ribbon-inbox"
        size={18}
      />
      <div className="ribbon-spacer" />
      <IconButton
        icon={Settings}
        command="settings:open"
        onClick={() => ui.openOverlay({ kind: "settings", section: "general" })}
        data-testid="ribbon-settings"
        size={18}
      />
    </nav>
  );
}

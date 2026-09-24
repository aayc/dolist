import { useServices } from "../../app/services";
import { hotkeyLabel } from "../../commands/labels";
import { ui } from "../../state/ui-store";

export function EmptyState() {
  const { workspace, commands } = useServices();
  const actions = [
    {
      label: "Open today's daily note",
      hotkey: hotkeyLabel(commands, "daily:today"),
      run: () => void workspace.openToday(),
    },
    {
      label: "Find a note",
      hotkey: hotkeyLabel(commands, "switcher:open"),
      run: () => ui.openOverlay({ kind: "switcher" }),
    },
    {
      label: "Create a new note",
      hotkey: hotkeyLabel(commands, "note:new"),
      run: () => void workspace.createNote(),
    },
  ];
  return (
    <div className="empty-state" data-testid="empty-state">
      <p className="empty-title">No note is open</p>
      <ul className="empty-actions">
        {actions.map((action) => (
          <li key={action.label}>
            <button type="button" className="link-button" onClick={action.run}>
              {action.label}
            </button>
            {action.hotkey ? <kbd>{action.hotkey}</kbd> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

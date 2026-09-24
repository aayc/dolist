import { useServices } from "../../app/services";
import { shortcutOf } from "../../commands/labels";
import { Keycaps } from "../../components/Keycaps";
import { ui } from "../../state/ui-store";

export function EmptyState() {
  const { workspace, commands } = useServices();
  const actions = [
    {
      label: "Open today's daily note",
      command: "daily:today",
      run: () => void workspace.openToday(),
    },
    {
      label: "Find a note",
      command: "switcher:open",
      run: () => ui.openOverlay({ kind: "switcher" }),
    },
    {
      label: "Create a new note",
      command: "note:new",
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
            <Keycaps hotkey={shortcutOf(commands.get(action.command))} />
          </li>
        ))}
      </ul>
    </div>
  );
}

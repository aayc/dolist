import { useSettingsStore } from "../../state/settings-store";
import { useTabsStore } from "../../state/tabs-store";
import { DailyHeader } from "../daily/DailyHeader";
import { dailyDateOf } from "../daily/daily-nav";
import { NoteTitle } from "./NoteTitle";

export function NoteHeader() {
  const active = useTabsStore((s) => s.active);
  const dailySettings = useSettingsStore((s) => s.settings.dailyNotes);
  if (!active) return null;
  const date = dailyDateOf(active, dailySettings);
  return (
    <header className="note-header" data-tooltip-placement="bottom">
      <div className="note-header-inner">
        {date ? <DailyHeader date={date} /> : <NoteTitle key={active} path={active} />}
      </div>
    </header>
  );
}

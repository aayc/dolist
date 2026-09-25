import { isDrawingPath } from "@ddl/core";
import { Shapes } from "lucide-react";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { useSettingsStore } from "../../state/settings-store";
import { useTabsStore } from "../../state/tabs-store";
import { NoteOrchestratorIndicator } from "../agent/OrchestratorIndicators";
import { DailyHeader } from "../daily/DailyHeader";
import { dailyDateOf } from "../daily/daily-nav";
import { NoteTitle } from "./NoteTitle";

export function NoteHeader() {
  const { workspace } = useServices();
  const active = useTabsStore((s) => s.active);
  const dailySettings = useSettingsStore((s) => s.settings.dailyNotes);
  if (!active) return null;
  const date = dailyDateOf(active, dailySettings);
  return (
    <header className="note-header" data-tooltip-placement="bottom">
      <div className="note-header-inner">
        <div className="note-header-main">
          {date ? <DailyHeader date={date} /> : <NoteTitle key={active} path={active} />}
          <NoteOrchestratorIndicator path={active} />
        </div>
        {isDrawingPath(active) ? null : (
          <div className="note-actions">
            <IconButton
              icon={Shapes}
              command="drawing:insert"
              onClick={() => void workspace.insertDrawing()}
              data-testid="insert-drawing"
            />
          </div>
        )}
      </div>
    </header>
  );
}

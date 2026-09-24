import {
  findAdjacentDailyNote,
  isSameLocalDate,
  type LocalDate,
  parseISODate,
  today,
  toISODate,
} from "@ddl/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useServices } from "../../app/services";
import { commandTooltip } from "../../commands/labels";
import { IconButton } from "../../components/IconButton";
import { dailyNoteTitle } from "../../lib/format";
import { useSettingsStore } from "../../state/settings-store";
import { useVaultStore } from "../../state/vault-store";

/**
 * A daily note's title is its date ("Thursday, September 24"), not editable. Below it, one quiet
 * row: arrows to the nearest existing daily note, and Today (or "Go to today").
 */
export function DailyHeader({ date }: { date: LocalDate }) {
  const { workspace, commands } = useServices();
  const files = useVaultStore((s) => s.files);
  const settings = useSettingsStore((s) => s.settings.dailyNotes);
  const iso = toISODate(date);
  const [hasPrevious, hasNext] = useMemo(() => {
    const anchor = parseISODate(iso);
    if (!anchor) return [false, false];
    return [
      findAdjacentDailyNote(files, anchor, -1, settings) !== null,
      findAdjacentDailyNote(files, anchor, 1, settings) !== null,
    ];
  }, [files, settings, iso]);
  const now = today();
  const isToday = isSameLocalDate(date, now);

  return (
    <div className="daily-header" data-testid="daily-header">
      <h1 className="note-title daily-title" data-testid="note-title">
        <time dateTime={iso}>{dailyNoteTitle(date, now)}</time>
      </h1>
      <nav className="daily-nav" aria-label="Daily notes">
        <IconButton
          icon={ChevronLeft}
          command="daily:previous"
          size={14}
          disabled={!hasPrevious}
          onClick={(event) => void workspace.openAdjacentDaily(-1, event.timeStamp)}
          data-testid="daily-prev"
        />
        <IconButton
          icon={ChevronRight}
          command="daily:next"
          size={14}
          disabled={!hasNext}
          onClick={(event) => void workspace.openAdjacentDaily(1, event.timeStamp)}
          data-testid="daily-next"
        />
        {isToday ? (
          <span className="daily-today-pill">Today</span>
        ) : (
          <button
            type="button"
            className="daily-today-button"
            onClick={(event) => void workspace.openToday(event.timeStamp)}
            {...commandTooltip(commands, "daily:today")}
            data-testid="daily-today"
          >
            Go to today
          </button>
        )}
      </nav>
    </div>
  );
}

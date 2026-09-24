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
import { hotkeyLabel } from "../../commands/labels";
import { IconButton } from "../../components/IconButton";
import { friendlyDate } from "../../lib/format";
import { useSettingsStore } from "../../state/settings-store";
import { useVaultStore } from "../../state/vault-store";

/** "‹ Wednesday, September 23, 2026 ›" — arrows go to the nearest existing daily note. */
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
  const isToday = isSameLocalDate(date, today());

  return (
    <div className="daily-header" data-testid="daily-header">
      <IconButton
        icon={ChevronLeft}
        label="Previous daily note"
        hotkey={hotkeyLabel(commands, "daily:previous")}
        disabled={!hasPrevious}
        onClick={(event) => void workspace.openAdjacentDaily(-1, event.timeStamp)}
        data-testid="daily-prev"
      />
      <time className="daily-date" dateTime={iso}>
        {friendlyDate(date)}
      </time>
      <IconButton
        icon={ChevronRight}
        label="Next daily note"
        hotkey={hotkeyLabel(commands, "daily:next")}
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
          data-testid="daily-today"
        >
          Go to today
        </button>
      )}
    </div>
  );
}

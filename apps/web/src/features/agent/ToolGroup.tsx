import type { ToolCallMessage } from "@ddl/core";
import { ChevronRight, CircleCheck, type LucideIcon } from "lucide-react";
import { memo, useState } from "react";
import { cx } from "../../lib/cx";
import { formatDuration, ToolCallRow } from "./ToolCallRow";
import { toolIcon } from "./tool-icons";

const MAX_ICONS = 4;

/** The first few tool families used, each with the name of the first tool that used it. */
function distinctIcons(calls: readonly ToolCallMessage[]): Array<[string, LucideIcon]> {
  const icons: Array<[string, LucideIcon]> = [];
  for (const call of calls) {
    const icon = toolIcon(call.toolName);
    if (!icons.some(([, known]) => known === icon)) icons.push([call.toolName, icon]);
    if (icons.length === MAX_ICONS) break;
  }
  return icons;
}

function sameCalls(
  a: { calls: readonly ToolCallMessage[] },
  b: { calls: readonly ToolCallMessage[] },
) {
  return a.calls.length === b.calls.length && a.calls.every((call, i) => call === b.calls[i]);
}

/** Consecutive finished tool calls, folded into one row ("Used 6 tools") that opens to show them. */
export const ToolGroup = memo(function ToolGroup({ calls }: { calls: readonly ToolCallMessage[] }) {
  const [open, setOpen] = useState(false);
  const first = calls[0]!;
  const last = calls[calls.length - 1]!;
  const took = last.endedAt ? formatDuration(last.endedAt - first.createdAt) : null;
  return (
    <div
      className={cx("tool-group", open && "is-open")}
      data-testid="tool-group"
      data-count={calls.length}
    >
      <button
        type="button"
        className="tool-call-header tool-group-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="tool-group-toggle"
      >
        <span className="tool-group-icons" aria-hidden="true">
          {distinctIcons(calls).map(([name, Icon]) => (
            <Icon key={name} size={13} />
          ))}
        </span>
        <span className="tool-group-label">Used {calls.length} tools</span>
        <span className="tool-call-spacer" />
        {took ? <span className="tool-call-duration">{took}</span> : null}
        <CircleCheck size={14} className="tone-success" aria-hidden="true" />
        <ChevronRight
          size={14}
          className={cx("tool-call-chevron", open && "is-open")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="tool-group-list">
          {calls.map((call) => (
            <ToolCallRow key={call.id} message={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}, sameCalls);

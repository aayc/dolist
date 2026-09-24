import type { TaskAgentStatus } from "@ddl/core";
import { cx } from "../../lib/cx";
import { STATUS_META } from "./status-meta";

export function StatusChip({ status, label }: { status: TaskAgentStatus; label?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cx("status-chip", `tone-${meta.tone}`, meta.pulse && "is-pulsing")}
      data-testid="status-chip"
      data-status={status}
    >
      <span className="status-chip-dot" aria-hidden="true" />
      {label ?? meta.label}
    </span>
  );
}

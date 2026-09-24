import { resolveTaskAnchors, type TaskAgentRecord } from "@ddl/core";
import type { LineAnnotation } from "@ddl/editor";

/** Pill text for a task's agent badge; null = no badge. */
export function badgeLabel(record: Pick<TaskAgentRecord, "status" | "summary">): string | null {
  const summary = record.summary?.trim();
  switch (record.status) {
    case "triaging":
      return "Triaging…";
    case "queued":
      return "Queued";
    case "working":
      return summary || "Working…";
    case "waiting_approval":
      return "Needs approval";
    case "waiting_user":
      return "Needs your input";
    case "done":
      return summary ? `Done · ${summary}` : "Done";
    case "failed":
      return summary ? `Failed · ${summary}` : "Failed";
    case "cancelled":
      return "Stopped";
    default:
      return null;
  }
}

/** Resolves records against the (possibly locally edited) document and builds editor annotations. */
export function buildAnnotations(
  doc: string,
  records: readonly TaskAgentRecord[],
): LineAnnotation[] {
  const visible = records.filter((r) => badgeLabel(r) !== null);
  if (visible.length === 0) return [];
  const lines = resolveTaskAnchors(
    doc,
    visible.map((r) => ({ taskId: r.taskId, text: r.text, line: r.line })),
  );
  const out: LineAnnotation[] = [];
  for (const record of visible) {
    const line = lines.get(record.taskId);
    if (line === undefined) continue;
    out.push({
      id: record.taskId,
      line,
      status: record.status,
      label: badgeLabel(record)!,
      unread: record.unread,
      threadId: record.threadId,
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

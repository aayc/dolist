import { resolveLineAnchors, resolveTaskAnchors, type TaskAgentRecord } from "@ddl/core";
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

/**
 * Resolves records against the (possibly locally edited) document and builds editor annotations.
 * Task records follow their task; line anchors (`anchor: "line"`) follow their line and highlight
 * it. Records whose task or line is gone get no badge.
 */
export function buildAnnotations(
  doc: string,
  records: readonly TaskAgentRecord[],
): LineAnnotation[] {
  const visible = records.filter((r) => badgeLabel(r) !== null);
  if (visible.length === 0) return [];
  const tasks = visible.filter((r) => r.anchor !== "line");
  const anchors = visible.filter((r) => r.anchor === "line");
  const taskLines =
    tasks.length > 0
      ? resolveTaskAnchors(
          doc,
          tasks.map((r) => ({ taskId: r.taskId, text: r.text, line: r.line })),
        )
      : new Map<string, number>();
  const anchorLines =
    anchors.length > 0
      ? resolveLineAnchors(
          doc,
          anchors.map((r) => ({ anchorId: r.taskId, text: r.text, line: r.line })),
        )
      : new Map<string, { line: number }>();
  const out: LineAnnotation[] = [];
  for (const record of visible) {
    const lineAnchor = record.anchor === "line";
    const line = lineAnchor ? anchorLines.get(record.taskId)?.line : taskLines.get(record.taskId);
    if (line === undefined) continue;
    out.push({
      id: record.taskId,
      line,
      status: record.status,
      label: badgeLabel(record)!,
      unread: record.unread,
      threadId: record.threadId,
      ...(lineAnchor ? { lineAnchor: true } : {}),
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

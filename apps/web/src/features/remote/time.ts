import { formatTimestamp, pluralize } from "../../lib/format";

/** "just now", "5 min ago", "3 hours ago", then the date and time. */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${pluralize(hours, "hour")} ago`;
  return formatTimestamp(ts, now);
}

/** Time left as m:ss ("4:59"), never negative. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

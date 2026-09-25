/** Approval-card phrases shared by screen-level and app-targeted computer tools. */
import { field, quote } from "./tool-helpers";

const LINE_BREAKS = /\r\n?|\n/g;

/**
 * Typing text `where` (e.g. "on the desktop", "in WhatsApp"), optionally `into` an element; every
 * line break presses Return, so the card must say so.
 */
export function describeTyping(text: string, where: string, into?: string): string {
  const target = into ? ` into ${into}` : "";
  const returns = text.match(LINE_BREAKS)?.length ?? 0;
  if (returns === 0) {
    return text.trim() ? `Type ${quote(text)}${target} ${where}` : `Type${target} ${where}`;
  }
  const times = returns === 1 ? "" : ` ${returns} times`;
  const body = text.replace(/(?:\r\n?|\n)+$/, "");
  if (!body.trim()) return `Press Return${times}${into ? ` in ${into}` : ""} ${where}`;
  if (!/[\r\n]/.test(body)) {
    return `Type ${quote(body)}${target} and press Return${times} ${where}`;
  }
  const count = returns === 1 ? "once" : `${returns} times`;
  return `Type ${quote(text.replace(LINE_BREAKS, "⏎"))}${target} ${where}, pressing Return ${count}`;
}

/** `down 5 and right 2`, or "" without movement. */
export function scrollPhrase(input: unknown): string {
  const dx = Number(field(input, "dx") ?? 0) || 0;
  const dy = Number(field(input, "dy") ?? 0) || 0;
  return [
    dy ? `${dy > 0 ? "down" : "up"} ${Math.abs(dy)}` : "",
    dx ? `${dx > 0 ? "right" : "left"} ${Math.abs(dx)}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

export function clickVerb(input: unknown): string {
  if (field(input, "double") === true) return "Double-click";
  return field(input, "button") === "right" ? "Right-click" : "Click";
}

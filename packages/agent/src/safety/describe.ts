/**
 * Human-readable one-line summaries of tool calls for approval cards, denial messages and logs,
 * e.g. `Click “Place order” in the browser` or `Type into “Card number” (value hidden)`.
 * Values typed into sensitive fields and anything secret-looking are always masked.
 */
import { drawingTitleFromPath } from "@ddl/core";
import { TOOL } from "../tools/contracts";
import { type ActionFacts, buildFacts } from "./facts";
import { isSensitiveField } from "./rules/ui";
import {
  HIDDEN_VALUE,
  looksLikeSecret,
  maskSensitiveText,
  redactSensitiveInput,
} from "./sensitive";
import type { ActionContext } from "./types";

const MAX_SUMMARY = 200;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function q(text: string, max = 60): string {
  return `“${clip(text, max)}”`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function sizeOf(text: string): string {
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function keyLabel(key: string): string {
  return key
    .split("+")
    .map((part) => (part.length <= 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join("+");
}

/** True when a typed value must not be displayed. */
export function hidesTypedValue(facts: ActionFacts): boolean {
  if (facts.ui?.action !== "type") return false;
  return (
    isSensitiveField(facts.element) ||
    (facts.typedText !== undefined && looksLikeSecret(facts.typedText))
  );
}

function describeUi(f: ActionFacts): string | undefined {
  const where = f.ui?.surface === "computer" ? "on the computer" : "in the browser";
  const target = f.elementLabel ? q(f.elementLabel) : undefined;
  const input = f.input;
  switch (f.ui?.action) {
    case "click": {
      const verb =
        input.double === true || input.doubleClick === true
          ? "Double-click"
          : input.button === "right"
            ? "Right-click"
            : "Click";
      const at =
        num(input.x) !== undefined && num(input.y) !== undefined
          ? ` at (${input.x}, ${input.y})`
          : "";
      return `${verb} ${target ?? "an element"}${f.ui.surface === "computer" ? ` on the screen${at}` : " in the browser"}`;
    }
    case "type": {
      const submit = f.submit ? " and submit" : "";
      const returns = f.ui.surface === "computer" && f.typedLineBreak ? " (presses Return)" : "";
      if (hidesTypedValue(f))
        return `Type into ${target ?? "a field"} (value hidden)${submit} ${where}${returns}`;
      const text = f.typedText ?? "";
      return target
        ? `Type ${q(text)} into ${target}${submit} ${where}${returns}`
        : `Type ${q(text)} ${where}${returns}`;
    }
    case "select": {
      const values = Array.isArray(input.values)
        ? input.values.filter((v) => typeof v === "string").join(", ")
        : (str(input.value) ?? "");
      return `Select ${q(values)} in ${target ?? "a dropdown"} ${where}`;
    }
    case "key":
      return `Press ${f.key ? keyLabel(f.key) : "a key"} ${where}`;
    case "navigate":
      return `Open ${clip(f.urls[0] ?? "a page", 120)} in the browser`;
    case "hover":
      return num(input.x) !== undefined
        ? `Move the mouse to (${input.x}, ${input.y})`
        : `Hover over ${target ?? "an element"} ${where}`;
    case "upload":
      return `Upload ${f.paths.length > 0 ? f.paths.slice(0, 3).join(", ") : "a file"} to the current page`;
    case "script":
      return "Run JavaScript in the current page";
    case "dialog":
      return input.accept === false ? "Dismiss the page dialog" : "Accept the page dialog";
    default:
      break;
  }
  const op = f.operation.replace(/^(?:browser|computer)_/, "");
  if (/screenshot/.test(op))
    return f.ui?.surface === "computer"
      ? "Take a screenshot of the screen"
      : "Take a browser screenshot";
  if (op === "snapshot") return "Read the current page";
  if (op === "extract_text") return "Extract text from the current page";
  if (op === "scroll") {
    if (f.ui?.surface === "computer") return "Scroll the screen";
    return `Scroll ${str(input.direction) ?? "down"} in the browser`;
  }
  if (/back/.test(op)) return "Go back in the browser";
  return undefined;
}

function describeMcp(f: ActionFacts): string {
  const mcp = f.mcp!;
  const input = f.input;
  const serverPrefix = new RegExp(`^(?:${mcp.server.replace(/[^a-z0-9]+/gi, "[_-]?")}[_-])+`, "i");
  const parts = [
    `${humanize(mcp.tool.replace(serverPrefix, "") || mcp.tool || "tool")} via ${mcp.server}`,
  ];
  const recipients = [
    "to",
    "recipients",
    "recipient",
    "attendees",
    "participants",
    "channel",
    "invitees",
  ]
    .map((k) => input[k])
    .flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]))
    .map((v) =>
      typeof v === "string"
        ? v
        : v && typeof v === "object"
          ? str((v as Record<string, unknown>).email)
          : undefined,
    )
    .filter((v): v is string => !!v);
  if (recipients.length > 0) parts.push(`to ${clip(recipients.slice(0, 3).join(", "), 80)}`);
  const title = str(input.subject) ?? str(input.title) ?? str(input.summary) ?? str(input.name);
  if (title) parts.push(`— ${q(title)}`);
  const amount = num(input.amount) ?? str(input.amount) ?? num(input.price) ?? str(input.price);
  if (amount !== undefined)
    parts.push(`for ${amount}${str(input.currency) ? ` ${str(input.currency)}` : ""}`);
  const when = str(input.start) ?? str(input.startTime) ?? str(input.date) ?? str(input.time);
  if (when) parts.push(`on ${clip(when, 40)}`);
  const extra =
    str(input.query) ?? str(input.sql) ?? str(input.command) ?? str(input.url) ?? str(input.path);
  const text = parts.join(" ");
  return !title && recipients.length === 0 && extra ? `${text}: ${clip(extra, 80)}` : text;
}

function describeInternal(f: ActionFacts): string {
  const input = f.input;
  switch (f.operation) {
    case TOOL.postUpdate:
      return "Post an update to the task thread";
    case TOOL.postComment:
      return "Comment on the task";
    case TOOL.askUser:
      return `Ask you: ${q(str(input.question) ?? "", 100)}`;
    case TOOL.createArtifact:
      return `Create artifact ${q(str(input.title) ?? "untitled")}`;
    case TOOL.finishTask:
      return `Finish the task (${str(input.status) ?? "done"})`;
    case TOOL.setTaskStatus:
      return `Set the task status to ${str(input.status) ?? "…"}`;
    case TOOL.listTasks:
      return "List tasks";
    case TOOL.spawnSubagent:
      return `Start a subagent: ${q(str(input.goal) ?? "", 100)}`;
    case TOOL.messageSubagent:
      return "Message a subagent";
    case TOOL.cancelSubagent:
      return "Cancel a subagent";
    case TOOL.readNote:
      return `Read note ${str(input.path) ?? ""}`.trim();
    case TOOL.searchNotes:
      return `Search notes for ${q(str(input.query) ?? "")}`;
    case TOOL.readDrawing: {
      const target = (str(input.path) ?? "").replace(/^!?\[\[|\]\]$/g, "").split(/[|#]/)[0]!;
      const title = drawingTitleFromPath(target.trim());
      return title ? `Look at drawing ${q(title, 100)}` : "Look at a drawing";
    }
    default:
      return humanize(f.operation);
  }
}

function describeFromFacts(f: ActionFacts): string {
  const input = f.input;
  const path = str(input.path);
  switch (f.family) {
    case "internal":
    case "knowledge":
      return describeInternal(f);
    case "web_search":
      return `Search the web for ${q(str(input.query) ?? "")}`;
    case "web_fetch":
      return `Fetch ${clip(f.urls[0] ?? "a web page", 120)}`;
    case "shell":
      return `Run shell command: ${clip(f.command ?? "", 160)}`;
    case "file_read":
      if (f.operation === TOOL.grep)
        return `Search files for ${q(str(input.pattern) ?? "")}${path ? ` in ${path}` : ""}`;
      if (f.operation === TOOL.find)
        return `Find files matching ${q(str(input.pattern) ?? "")}${path ? ` in ${path}` : ""}`;
      if (f.operation === TOOL.ls) return `List ${path ?? "the workspace"}`;
      return `Read file ${path ?? ""}`.trim();
    case "file_write": {
      const content = str(input.content);
      if (f.operation === TOOL.write)
        return `Write file ${path ?? "(no path)"}${content ? ` (${sizeOf(content)})` : ""}`;
      return `Edit file ${path ?? "(no path)"}`;
    }
    case "note_edit": {
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      return `Edit note ${str(input.notePath) ?? "(the task's note)"}: ${edits} change${edits === 1 ? "" : "s"}`;
    }
    case "routine":
      return `${humanize(f.operation)}${str(input.name) ? ` “${clip(str(input.name)!, 80)}”` : ""}`;
    case "browser":
    case "computer":
      return describeUi(f) ?? humanize(f.operation);
    case "mcp":
      return (f.ui && describeUi(f)) || describeMcp(f);
    case "custom": {
      const preview = clip(JSON.stringify(redactSensitiveInput(f.input)) ?? "", 100);
      const name = (f.ctx.toolLabel ?? f.ctx.toolName).trim() || "an unnamed tool";
      return `Run ${name}${preview && preview !== "{}" ? ` ${preview}` : ""}`;
    }
  }
}

/** One-line description of an action. Tool-provided `describe()` hints win when they work. */
export function describeAction(ctx: ActionContext, facts: ActionFacts = buildFacts(ctx)): string {
  let summary: string | undefined;
  try {
    const custom = ctx.hints?.describe?.(ctx.input);
    if (typeof custom === "string" && custom.trim() !== "") summary = custom;
  } catch {
    // A broken describe() must not break safety evaluation; fall back to the built-in text.
  }
  summary ??= describeFromFacts(facts);
  return clip(maskSensitiveText(summary), MAX_SUMMARY);
}

/**
 * The tool input as shown on approval cards and persisted with approvals: typed values in
 * sensitive fields are hidden and secrets, card numbers and SSNs are masked everywhere.
 */
export function redactActionInput(
  ctx: ActionContext,
  facts: ActionFacts = buildFacts(ctx),
): unknown {
  const hideKeys = hidesTypedValue(facts) ? new Set(["text", "value"]) : undefined;
  const redacted = redactSensitiveInput(ctx.input, hideKeys ? { hideKeys } : {});
  if (
    hideKeys &&
    redacted &&
    typeof redacted === "object" &&
    Array.isArray((redacted as Record<string, unknown>).fields)
  ) {
    for (const field of (redacted as { fields: unknown[] }).fields) {
      if (field && typeof field === "object" && "value" in field)
        (field as Record<string, unknown>).value = HIDDEN_VALUE;
    }
  }
  return redacted;
}

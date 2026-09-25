import type { ApprovalRequest, TaskAgentStatus, ThreadMessage } from "@ddl/core";
import { graphemes } from "./reveal";

/*
 * What the agent is doing right now, in words shared with the macOS app (change both together):
 * the live activity row at the end of the chat says it while the thread's agent is queued or
 * running.
 */

export const ACTIVITY_TEXT = {
  queued: "Waiting to start…",
  approval: "Waiting for your approval",
  thinking: "Thinking…",
} as const;

/** Interpolated values (apps, elements, queries, hosts) are clipped to this many clusters. */
export const ACTIVITY_CLIP = 40;

export interface ToolCallLike {
  toolName: string;
  input?: unknown;
  label?: string;
}

/** Whitespace collapsed, trimmed, and at most `ACTIVITY_CLIP` clusters (the last one "…"). */
export function clipText(value: string, max = ACTIVITY_CLIP): string {
  const text = value.replace(/\s+/g, " ").trim();
  const clusters = graphemes(text);
  if (clusters.length <= max) return text;
  return `${clusters
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

function raw(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function field(input: unknown, key: string): string | undefined {
  const text = clipText(raw(input, key) ?? "");
  return text ? text : undefined;
}

const quoted = (text: string) => `“${text}”`;

/** The host of a URL without "www." (https:// assumed when it has no scheme). */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  for (const candidate of [url, `https://${url}`]) {
    try {
      const host = new URL(candidate).hostname.replace(/^www\./i, "");
      if (host) return clipText(host);
    } catch {
      // Not a URL as written; try with a scheme.
    }
  }
  return undefined;
}

/** "post_update" → "Post update". */
export function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function inApp(app: string | undefined, fallback: string): string {
  return app ? ` in ${app}` : fallback;
}

/**
 * What a running tool call is doing, as the activity row says it ("Opening Safari…"). It ends
 * with one "…", even when a clipped value already does.
 */
export function activityLabel(call: ToolCallLike): string {
  const phrase = activityPhrase(call);
  return phrase.endsWith("…") ? phrase : `${phrase}…`;
}

function activityPhrase(call: ToolCallLike): string {
  const { toolName, input } = call;
  const app = field(input, "app");
  switch (toolName) {
    case "computer_open_app":
      return `Opening ${app ?? "an app"}`;
    case "computer_app_state":
    case "computer_screenshot":
      return app ? `Looking at ${app}` : "Looking at the screen";
    case "computer_press": {
      const element = field(input, "element");
      return `Pressing ${element ? quoted(element) : "a control"}${inApp(app, "")}`;
    }
    case "computer_set_value":
    case "computer_type":
      return `Typing${inApp(app, "")}`;
    case "computer_key":
      return `Pressing ${field(input, "combo") ?? "a key"}${inApp(app, "")}`;
    case "computer_click":
      return `Clicking${inApp(app, " on the screen")}`;
    case "computer_scroll":
      return `Scrolling${inApp(app, " on the screen")}`;
    case "browser_navigate":
      return `Opening ${hostOf(raw(input, "url")) ?? "a page"}`;
    case "browser_snapshot":
    case "browser_extract_text":
      return "Reading the page";
    case "web_search": {
      const query = field(input, "query");
      return query ? `Searching the web for ${quoted(query)}` : "Searching the web";
    }
    case "web_fetch":
      return `Reading ${hostOf(raw(input, "url")) ?? "a page"}`;
    case "read_note":
    case "search_notes":
      return "Reading your notes";
    case "edit_note":
      return "Editing your note";
    case "bash":
      return "Running a command";
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "Looking through files";
    case "write":
    case "edit":
      return "Writing files";
  }
  if (toolName.startsWith("browser_")) return "Working in the browser";
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice("mcp__".length);
    const server = rest.includes("__") ? rest.slice(0, rest.indexOf("__")) : rest;
    if (server.trim()) return `Using ${clipText(server)}`;
  }
  const label = clipText((call.label ?? "").replace(/(?:…|\.+)\s*$/, ""));
  return label || clipText(humanizeToolName(toolName));
}

export type Activity =
  | { kind: "queued" }
  | { kind: "approval"; approvalId: string | null; since: number | null }
  | { kind: "tool"; messageId: string; toolName: string; label: string; since: number }
  | { kind: "thinking" };

export interface ActivityInput {
  status: TaskAgentStatus;
  messages: readonly ThreadMessage[];
  /** This thread's pending approval, if any (the newest). */
  approval: ApprovalRequest | undefined;
  /** A message of this thread is still typing out on screen. */
  revealing: boolean;
}

const RUNNING: ReadonlySet<TaskAgentStatus> = new Set(["triaging", "working", "waiting_approval"]);

/**
 * The activity row's content, or null when there's none: only while the agent is queued or running,
 * the first of a pending approval, the latest running tool call, nothing while text is streaming or
 * typing out (the caret says it), else thinking.
 */
export function deriveActivity({
  status,
  messages,
  approval,
  revealing,
}: ActivityInput): Activity | null {
  if (status === "queued") return { kind: "queued" };
  if (!RUNNING.has(status)) return null;
  if (approval || status === "waiting_approval") {
    return {
      kind: "approval",
      approvalId: approval?.id ?? null,
      since: approval?.createdAt ?? null,
    };
  }
  let streaming = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.kind === "tool_call" && message.status === "running") {
      return {
        kind: "tool",
        messageId: message.id,
        toolName: message.toolName,
        label: activityLabel(message),
        since: message.createdAt,
      };
    }
    if (message.kind === "text" && message.streaming) streaming = true;
  }
  if (streaming || revealing) return null;
  return { kind: "thinking" };
}

/** The pending approval of `threadId` asked most recently. */
export function pendingApprovalOf(
  approvals: Readonly<Record<string, ApprovalRequest>>,
  threadId: string,
): ApprovalRequest | undefined {
  let found: ApprovalRequest | undefined;
  for (const approval of Object.values(approvals)) {
    if (approval.threadId !== threadId || approval.status !== "pending") continue;
    if (!found || approval.createdAt > found.createdAt) found = approval;
  }
  return found;
}

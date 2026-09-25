import type { ThreadMessage, ToolCallMessage } from "@ddl/core";

export type ChatItem =
  | { kind: "message"; message: ThreadMessage }
  | { kind: "tools"; id: string; calls: readonly ToolCallMessage[] };

const finished = (message: ThreadMessage): message is ToolCallMessage =>
  message.kind === "tool_call" && message.status === "ok";

/**
 * The chat's rows: consecutive tool calls that finished fine collapse into one group (two or
 * more); running and failed calls stay visible, and so does a call that just finished while it's
 * the thread's last message, so its ✓ shows before the next step folds it in.
 */
export function chatItems(messages: readonly ThreadMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (!finished(message)) {
      items.push({ kind: "message", message });
      i++;
      continue;
    }
    let end = i;
    while (end < messages.length && finished(messages[end]!)) end++;
    const groupEnd = end === messages.length ? end - 1 : end;
    if (groupEnd - i >= 2) {
      items.push({
        kind: "tools",
        id: message.id,
        calls: messages.slice(i, groupEnd) as ToolCallMessage[],
      });
    } else {
      for (let j = i; j < groupEnd; j++) items.push({ kind: "message", message: messages[j]! });
    }
    for (let j = groupEnd; j < end; j++) items.push({ kind: "message", message: messages[j]! });
    i = end;
  }
  return items;
}

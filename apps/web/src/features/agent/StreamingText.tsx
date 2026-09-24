import type { Thread } from "@ddl/core";
import { useLayoutEffect, useRef } from "react";
import { useAgentStore } from "../../state/agent-store";

function textOf(thread: Thread | undefined, messageId: string): string {
  if (!thread) return "";
  const messages = thread.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.id === messageId) return message.kind === "text" ? message.text : "";
  }
  return "";
}

/**
 * Streaming deltas are appended to a text node through a transient store subscription: no React
 * render per token. The final message (streaming=false) re-renders once as markdown.
 */
export function StreamingText({ threadId, messageId }: { threadId: string; messageId: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let rendered = textOf(useAgentStore.getState().details[threadId], messageId);
    const node = document.createTextNode(rendered);
    element.replaceChildren(node);
    return useAgentStore.subscribe((state, previous) => {
      const thread = state.details[threadId];
      if (thread === previous.details[threadId]) return;
      const text = textOf(thread, messageId);
      if (text === rendered) return;
      if (text.startsWith(rendered)) node.appendData(text.slice(rendered.length));
      else node.data = text;
      rendered = text;
    });
  }, [threadId, messageId]);

  return (
    <p className="streaming-text" data-testid="message-streaming">
      <span ref={ref} />
      <span className="streaming-caret" aria-hidden="true" />
    </p>
  );
}

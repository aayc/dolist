import type { TextMessage, Thread } from "@ddl/core";
import { useLayoutEffect, useRef } from "react";
import { onEveryFrame, prefersReducedMotion } from "../../lib/frame-loop";
import { lexMarkdown, renderMarkdown, renderMarkdownBlock } from "../../lib/markdown";
import { useAgentStore } from "../../state/agent-store";
import { type AgentTextDeps, AgentTextView } from "./agent-text-view";
import { decorateCodeBlocks } from "./code-copy";
import { markRevealing } from "./reveal-store";

const DEPS: AgentTextDeps = {
  renderWhole: renderMarkdown,
  blocks: { lex: lexMarkdown, render: renderMarkdownBlock },
  frames: onEveryFrame,
  reducedMotion: prefersReducedMotion,
};

/** The latest copy of a text message (the row skips re-renders while it streams). */
export function findTextMessage(thread: Thread | undefined, messageId: string) {
  const messages = thread?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.id === messageId) return message.kind === "text" ? message : undefined;
  }
  return undefined;
}

/**
 * Agent (or system) markdown kept current by a store subscription, painted by `AgentTextView`: no
 * React render per delta or per character. `live` text types out; history shows at once.
 */
export function AgentText({
  threadId,
  message,
  live,
}: {
  threadId: string;
  message: TextMessage;
  live: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(message);
  const animate = live && message.role === "agent";
  const messageId = message.id;

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const current =
      findTextMessage(useAgentStore.getState().details[threadId], messageId) ?? initial.current;
    const view = new AgentTextView(root, current.text, current.streaming === true, DEPS, {
      live: animate,
      // The row's own ref isn't attached yet when a child's layout effect runs.
      host: root.closest<HTMLElement>(".message"),
      onRevealing: (revealing) => markRevealing(threadId, revealing),
      onSettled: decorateCodeBlocks,
    });
    const unsubscribe = useAgentStore.subscribe((state, previous) => {
      const thread = state.details[threadId];
      if (thread === previous.details[threadId]) return;
      const latest = findTextMessage(thread, messageId);
      if (latest) view.update(latest.text, latest.streaming === true);
    });
    return () => {
      unsubscribe();
      view.dispose();
    };
  }, [threadId, messageId, animate]);

  return <div ref={ref} className="markdown" />;
}

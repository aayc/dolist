import type { ThreadMessage } from "@ddl/core";
import { useLayoutEffect, useRef } from "react";
import { useAgentStore } from "../../state/agent-store";
import { Composer } from "./Composer";
import { MessageRow } from "./MessageRow";
import { useMarkdownLinks } from "./markdown-links";

const NO_MESSAGES: readonly ThreadMessage[] = [];
/** Within this distance from the bottom the list stays pinned to new content. */
const PIN_THRESHOLD_PX = 48;

export function ChatTab({ threadId }: { threadId: string }) {
  const messages = useAgentStore((s) => s.details[threadId]?.messages ?? NO_MESSAGES);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useMarkdownLinks(scrollRef, threadId);

  // Streaming text grows the DOM without React renders; follow it while pinned to the bottom.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    scroller.scrollTop = scroller.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="chat">
      <div
        ref={scrollRef}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
        }}
      >
        <div ref={contentRef} className="chat-list" data-testid="chat-list">
          {messages.map((message) => (
            <MessageRow key={message.id} threadId={threadId} message={message} />
          ))}
        </div>
      </div>
      <Composer threadId={threadId} />
    </div>
  );
}

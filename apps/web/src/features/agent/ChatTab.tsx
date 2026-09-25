import type { ThreadMessage } from "@ddl/core";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useServices } from "../../app/services";
import { Count } from "../../components/Count";
import { cx } from "../../lib/cx";
import { useAgentStore } from "../../state/agent-store";
import {
  discardMessage,
  matchPending,
  type PostMessage,
  pendingOf,
  pruneConfirmed,
  retryMessage,
  useOutboxStore,
} from "../../state/outbox-store";
import { ActivityRow } from "./ActivityRow";
import { Composer } from "./Composer";
import { chatItems } from "./chat-items";
import { installCodeCopy } from "./code-copy";
import { MessageRow } from "./MessageRow";
import { useMarkdownLinks } from "./markdown-links";
import { PendingReply } from "./PendingReply";
import { ToolGroup } from "./ToolGroup";
import { useChatScroll } from "./use-chat-scroll";

const NO_MESSAGES: readonly ThreadMessage[] = [];

export function ChatTab({ threadId }: { threadId: string }) {
  const { agent } = useServices();
  const messages = useAgentStore((s) => s.details[threadId]?.messages ?? NO_MESSAGES);
  const pending = useOutboxStore((s) => pendingOf(s, threadId));
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // What was there when the chat opened is history: it renders at once, without animation.
  const history = useRef<ReadonlySet<string> | null>(null);
  history.current ??= new Set(messages.map((m) => m.id));
  const seen = history.current;
  useMarkdownLinks(scrollRef, threadId);
  const scroll = useChatScroll(scrollRef, contentRef, messages);

  useEffect(() => {
    const root = scrollRef.current;
    return root ? installCodeCopy(root) : undefined;
  }, []);

  const items = useMemo(() => chatItems(messages), [messages]);
  const unconfirmed = useMemo(
    () => matchPending(pending, messages).unconfirmed,
    [pending, messages],
  );
  useEffect(() => {
    if (pending.length > 0) pruneConfirmed(threadId, messages);
  }, [threadId, messages, pending]);

  const post: PostMessage = useCallback((id, text) => agent.postMessage(id, text), [agent]);

  return (
    <div className="chat">
      <div className="chat-main">
        <div
          ref={scrollRef}
          className="chat-scroll"
          onScroll={scroll.onScroll}
          onWheel={scroll.onWheel}
          data-testid="chat-scroll"
        >
          <div ref={contentRef} className="chat-list" data-testid="chat-list">
            {items.map((item) =>
              item.kind === "tools" ? (
                <ToolGroup key={`tools:${item.id}`} calls={item.calls} />
              ) : (
                <MessageRow
                  key={item.message.id}
                  threadId={threadId}
                  message={item.message}
                  live={!seen.has(item.message.id)}
                />
              ),
            )}
            {unconfirmed.map((item) => (
              <PendingReply
                key={item.id}
                item={item}
                onRetry={() => void retryMessage(post, threadId, item.id)}
                onDiscard={() => discardMessage(threadId, item.id)}
              />
            ))}
            <ActivityRow threadId={threadId} onShowApproval={scroll.showApproval} />
          </div>
        </div>
        <button
          type="button"
          className={cx("jump-latest", !scroll.pinned && "is-visible")}
          onClick={scroll.jumpToLatest}
          data-testid="jump-latest"
        >
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
          {scroll.newCount > 0 ? (
            <span className="jump-latest-count">
              <Count value={scroll.newCount} className="jump-latest-number" /> new
            </span>
          ) : null}
        </button>
      </div>
      <Composer threadId={threadId} post={post} onSend={scroll.jumpToLatest} />
    </div>
  );
}

import type { ThreadMessage } from "@ddl/core";
import { ArrowDown } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { useServices } from "../../app/services";
import { Count } from "../../components/Count";
import { cx } from "../../lib/cx";
import {
  discardMessage,
  matchPending,
  type PendingMessage,
  type PostMessage,
  pendingOf,
  pruneConfirmed,
  retryMessage,
  useOutboxStore,
} from "../../state/outbox-store";
import { ActivityRow } from "./ActivityRow";
import { Composer } from "./Composer";
import { installCodeCopy } from "./code-copy";
import { useMarkdownLinks } from "./markdown-links";
import { PendingReply } from "./PendingReply";
import { type ChatScroll, useChatScroll } from "./use-chat-scroll";

export interface Chat {
  threadId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** What was there when the chat opened: history renders at once, without animation. */
  seen: ReadonlySet<string>;
  scroll: ChatScroll;
  /** Replies sent but not in the thread yet. */
  unconfirmed: readonly PendingMessage[];
  post: PostMessage;
}

/** The state behind a thread's chat: scrolling, code copy, links and optimistic replies. */
export function useChat(threadId: string, messages: readonly ThreadMessage[], rows: number): Chat {
  const { agent } = useServices();
  const pending = useOutboxStore((s) => pendingOf(s, threadId));
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const history = useRef<ReadonlySet<string> | null>(null);
  history.current ??= new Set(messages.map((m) => m.id));
  useMarkdownLinks(scrollRef, threadId);
  const scroll = useChatScroll(scrollRef, contentRef, messages, rows);

  useEffect(() => {
    const root = scrollRef.current;
    return root ? installCodeCopy(root) : undefined;
  }, []);

  const unconfirmed = useMemo(
    () => matchPending(pending, messages).unconfirmed,
    [pending, messages],
  );
  useEffect(() => {
    if (pending.length > 0) pruneConfirmed(threadId, messages);
  }, [threadId, messages, pending]);

  const post: PostMessage = useCallback((id, text) => agent.postMessage(id, text), [agent]);
  return { threadId, scrollRef, contentRef, seen: history.current, scroll, unconfirmed, post };
}

/** A chat's frame around its rows: optimistic replies, activity, jump to latest and composer. */
export function ChatFrame({ chat, children }: { chat: Chat; children: ReactNode }) {
  const { threadId, scroll, post } = chat;
  return (
    <div className="chat">
      <div className="chat-main">
        <div
          ref={chat.scrollRef}
          className="chat-scroll"
          onScroll={scroll.onScroll}
          onWheel={scroll.onWheel}
          data-testid="chat-scroll"
        >
          <div ref={chat.contentRef} className="chat-list" data-testid="chat-list">
            {children}
            {chat.unconfirmed.map((item) => (
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

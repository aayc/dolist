import type { ThreadMessage } from "@ddl/core";
import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "../../lib/frame-loop";

/** Within this distance from the bottom the list stays pinned to new content. */
const PIN_THRESHOLD_PX = 48;
/** A smooth jump that never reports its end (no `scrollend`) is over by then. */
const JUMP_TIMEOUT_MS = 1000;
/** How long an approval card asks for attention again (its CSS animation's length). */
const FLASH_MS = 1400;

/** What the "Jump to latest" count counts: things to read, not tool steps or status lines. */
function countable(message: ThreadMessage): boolean {
  return (
    (message.kind === "text" && message.role !== "user") ||
    message.kind === "approval" ||
    message.kind === "artifact"
  );
}

export interface ChatScroll {
  /** At the bottom, following new content. */
  pinned: boolean;
  /** Messages that arrived since you scrolled up. */
  newCount: number;
  onScroll(): void;
  onWheel(): void;
  /** Glides to the bottom and follows new content again (at once when already there). */
  jumpToLatest(): void;
  /** Scrolls a card into view and asks for attention again. */
  showApproval(approvalId: string): void;
}

/**
 * Keeps the chat pinned to the bottom while you're there (text grows without React renders, so a
 * ResizeObserver follows it) and never yanks you down once you scrolled up.
 */
export function useChatScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  messages: readonly ThreadMessage[],
): ChatScroll {
  const pinnedRef = useRef(true);
  const [pinned, setPinnedState] = useState(true);
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(messages);
  latest.current = messages;
  const seenWhenUnpinned = useRef<ReadonlySet<string>>(new Set());

  const setPinned = useCallback((value: boolean) => {
    if (pinnedRef.current === value) return;
    pinnedRef.current = value;
    if (!value) seenWhenUnpinned.current = new Set(latest.current.map((m) => m.id));
    setPinnedState(value);
  }, []);

  const endJump = useCallback(() => {
    if (jumping.current === null) return;
    clearTimeout(jumping.current);
    jumping.current = null;
    const scroller = scrollRef.current;
    if (scroller && pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [scrollRef]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    scroller.scrollTop = scroller.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && jumping.current === null) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    scroller.addEventListener("scrollend", endJump);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scrollend", endJump);
      if (jumping.current !== null) clearTimeout(jumping.current);
    };
  }, [scrollRef, contentRef, endJump]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    // A smooth jump passes through "not at the bottom" on its way there.
    if (jumping.current !== null) {
      if (atBottom) endJump();
      return;
    }
    setPinned(atBottom);
  }, [scrollRef, setPinned, endJump]);

  const onWheel = useCallback(() => {
    if (jumping.current === null) return;
    clearTimeout(jumping.current);
    jumping.current = null;
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasPinned = pinnedRef.current;
    setPinned(true);
    if (wasPinned || prefersReducedMotion()) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (jumping.current !== null) clearTimeout(jumping.current);
    jumping.current = setTimeout(endJump, JUMP_TIMEOUT_MS);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef, setPinned, endJump]);

  const showApproval = useCallback(
    (approvalId: string) => {
      const card = scrollRef.current?.querySelector<HTMLElement>(
        `[data-approval-id="${CSS.escape(approvalId)}"]`,
      );
      if (!card) return;
      card.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      card.classList.remove("is-flashing");
      void card.offsetWidth;
      card.classList.add("is-flashing");
      setTimeout(() => card.classList.remove("is-flashing"), FLASH_MS);
    },
    [scrollRef],
  );

  const newCount = useMemo(() => {
    if (pinned) return 0;
    const seen = seenWhenUnpinned.current;
    let count = 0;
    for (const message of messages) if (countable(message) && !seen.has(message.id)) count++;
    return count;
  }, [pinned, messages]);

  return { pinned, newCount, onScroll, onWheel, jumpToLatest, showApproval };
}

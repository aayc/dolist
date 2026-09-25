import { isActiveTaskStatus, type TaskAgentStatus } from "@ddl/core";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { KEYS } from "../../commands/hotkeys";
import { IconButton } from "../../components/IconButton";
import { Keycaps } from "../../components/Keycaps";
import { cx } from "../../lib/cx";
import { useAgentStore } from "../../state/agent-store";
import { type PostMessage, sendMessage } from "../../state/outbox-store";
import { pendingApprovalOf } from "./activity";

const FINISHED: ReadonlySet<TaskAgentStatus> = new Set(["done", "failed", "cancelled", "ignored"]);
/** A Stop that got no status change back (the request failed) can be pressed again after this. */
const STOPPING_MS = 5000;

export function composerPlaceholder(
  enabled: boolean,
  status: TaskAgentStatus,
  waitingApproval: boolean,
): string {
  if (!enabled) return "The agent is off";
  if (waitingApproval) return "Approve above, or reply to change course…";
  if (FINISHED.has(status)) return "Ask a follow-up…";
  return "Reply to the agent…";
}

/**
 * Sizes the input to its text, from one line up to its CSS max-height (8 lines), then it scrolls.
 * `sizer` mirrors the text with the same font, padding and width; the height change animates.
 */
function fitHeight(input: HTMLTextAreaElement, sizer: HTMLElement): void {
  const natural = sizer.offsetHeight;
  const max = Number.parseFloat(getComputedStyle(input).maxHeight) || Number.POSITIVE_INFINITY;
  input.style.height = `${Math.min(natural, max)}px`;
  input.style.overflowY = natural > max ? "auto" : "hidden";
}

/** The chat bar: an auto-growing reply box with Send, and Stop while the agent works. */
export function Composer({
  threadId,
  post,
  onSend,
}: {
  threadId: string;
  post: PostMessage;
  /** A reply went out (the chat scrolls to it). */
  onSend?: () => void;
}) {
  const { agent } = useServices();
  const enabled = useAgentStore((s) => s.status?.enabled ?? true);
  const status = useAgentStore(
    (s) => s.details[threadId]?.status ?? s.threads[threadId]?.status ?? "idle",
  );
  const waitingApproval = useAgentStore(
    (s) => pendingApprovalOf(s.approvals, threadId) !== undefined,
  );
  const [text, setText] = useState("");
  const [stopping, setStopping] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const placeholder = composerPlaceholder(enabled, status, waitingApproval);
  const working = isActiveTaskStatus(status);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the sizer shows the text or placeholder
  useLayoutEffect(() => {
    const fit = () => {
      if (input.current && sizer.current) fitHeight(input.current, sizer.current);
    };
    if (text) {
      fit();
      return;
    }
    // Empty, the CSS height is almost always right: measuring now would force a layout of the
    // whole thread as it opens. Check after the first paint (a long placeholder can wrap).
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [text, placeholder]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a status change answers the Stop
  useEffect(() => setStopping(false), [status]);
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOPPING_MS);
    return () => clearTimeout(timer);
  }, [stopping]);

  const send = () => {
    const message = text.trim();
    if (!message || !enabled) return;
    const messages = useAgentStore.getState().details[threadId]?.messages ?? [];
    void sendMessage(post, threadId, message, messages);
    setText("");
    onSend?.();
  };

  const stop = () => {
    setStopping(true);
    void agent.cancel(threadId);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className={cx("composer-box", !enabled && "is-disabled")}>
        <div className="composer-field">
          <div ref={sizer} className="composer-sizer" aria-hidden="true">
            {text || placeholder}
            {"\u200b"}
          </div>
          <textarea
            ref={input}
            className="composer-input"
            value={text}
            rows={1}
            disabled={!enabled}
            placeholder={placeholder}
            aria-label="Message the agent"
            aria-describedby={hintId}
            data-testid="composer-input"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div className="composer-bar">
          <span id={hintId} className="composer-hint">
            <Keycaps hotkey={KEYS.enter} /> to send
            <span className="composer-hint-gap" />
            <Keycaps hotkey={KEYS.shiftEnter} /> new line
          </span>
          {working ? (
            <IconButton
              icon={stopping ? LoaderCircle : Square}
              command="agent:stop"
              className={cx("composer-stop", stopping && "is-stopping")}
              disabled={stopping}
              onClick={stop}
              data-testid="composer-stop"
            />
          ) : null}
          <IconButton
            icon={ArrowUp}
            label="Send"
            keys="enter"
            type="submit"
            disabled={!enabled || !text.trim()}
            className="composer-send"
            data-testid="composer-send"
          />
        </div>
      </div>
    </form>
  );
}

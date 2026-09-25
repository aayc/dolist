import { CircleAlert, LoaderCircle } from "lucide-react";
import { cx } from "../../lib/cx";
import type { PendingMessage } from "../../state/outbox-store";

/** Your reply before the daemon has it: faded while sending, with a retry if it failed. */
export function PendingReply({
  item,
  onRetry,
  onDiscard,
}: {
  item: PendingMessage;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={cx("message is-user is-pending is-entering", `is-${item.state}`)}
      data-testid="message-pending"
      data-state={item.state}
    >
      <div className="message-line">
        <div className="message-meta">
          {item.state === "sending" ? (
            <LoaderCircle size={12} className="spin" aria-label="Sending" />
          ) : null}
        </div>
        <div className="message-bubble message-body">
          <p className="message-plain">{item.text}</p>
        </div>
      </div>
      {item.state === "failed" ? (
        <div className="message-failed" role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          <span data-tooltip={item.error}>Couldn't send</span>
          <button
            type="button"
            className="link-button"
            onClick={onRetry}
            data-testid="message-retry"
          >
            Retry
          </button>
          <button
            type="button"
            className="link-button is-quiet"
            onClick={onDiscard}
            data-testid="message-discard"
          >
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

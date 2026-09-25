import { cx } from "../../lib/cx";
import { type ConfirmRequest, ui } from "../../state/ui-store";
import { Modal } from "./Modal";

/**
 * A yes/no question. As the overlay it closes the overlay; on top of another dialog (rendered in a
 * portal) `onClose` dismisses just this one.
 */
export function ConfirmDialog({
  request,
  onClose = ui.closeOverlay,
}: {
  request: ConfirmRequest;
  onClose?: () => void;
}) {
  return (
    <Modal
      label={request.title}
      className="confirm-dialog"
      testId="confirm-dialog"
      onClose={onClose}
    >
      <h2 className="modal-title">{request.title}</h2>
      <p className="modal-body">{request.message}</p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => onClose()}>
          Cancel
        </button>
        <button
          type="button"
          className={cx("button", request.danger ? "is-danger" : "is-primary")}
          data-testid="confirm-accept"
          // biome-ignore lint/a11y/noAutofocus: the confirm action is the expected keyboard target
          autoFocus
          onClick={() => {
            onClose();
            request.onConfirm();
          }}
        >
          {request.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

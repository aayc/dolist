import { cx } from "../../lib/cx";
import { type ConfirmRequest, ui } from "../../state/ui-store";
import { Modal } from "./Modal";

export function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  return (
    <Modal label={request.title} className="confirm-dialog" testId="confirm-dialog">
      <h2 className="modal-title">{request.title}</h2>
      <p className="modal-body">{request.message}</p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => ui.closeOverlay()}>
          Cancel
        </button>
        <button
          type="button"
          className={cx("button", request.danger ? "is-danger" : "is-primary")}
          data-testid="confirm-accept"
          // biome-ignore lint/a11y/noAutofocus: the confirm action is the expected keyboard target
          autoFocus
          onClick={() => {
            ui.closeOverlay();
            request.onConfirm();
          }}
        >
          {request.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

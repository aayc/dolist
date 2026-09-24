import { CircleAlert, CircleCheck, Info, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { memo, useEffect } from "react";
import { cx } from "../../lib/cx";
import { dismissToast, type Toast, type ToastKind, useToastStore } from "../../state/toast-store";
import "../../styles/toasts.css";

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  approval: ShieldAlert,
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <section className="toaster" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </section>
  );
}

const ToastView = memo(function ToastView({ toast }: { toast: Toast }) {
  const Icon = ICONS[toast.kind];
  useEffect(() => {
    if (toast.timeoutMs <= 0) return;
    const timer = setTimeout(() => dismissToast(toast.id), toast.timeoutMs);
    return () => clearTimeout(timer);
  }, [toast.id, toast.timeoutMs]);

  const activate = () => {
    if (!toast.onClick) return;
    dismissToast(toast.id);
    toast.onClick();
  };

  return (
    <div
      className={cx("toast", `is-${toast.kind}`, toast.onClick && "is-clickable")}
      role={toast.kind === "error" ? "alert" : "status"}
      data-testid="toast"
      data-kind={toast.kind}
    >
      <Icon size={16} className="toast-icon" aria-hidden="true" />
      <button
        type="button"
        className="toast-content"
        onClick={activate}
        disabled={!toast.onClick}
        data-testid="toast-body"
      >
        <span className="toast-title">{toast.title}</span>
        {toast.body ? <span className="toast-body">{toast.body}</span> : null}
      </button>
      {toast.actionLabel && toast.onClick ? (
        <button type="button" className="toast-action" onClick={activate}>
          {toast.actionLabel}
        </button>
      ) : null}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        data-tooltip="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
});

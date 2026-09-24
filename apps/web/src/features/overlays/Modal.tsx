import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "../../lib/cx";
import { ui } from "../../state/ui-store";

interface ModalProps {
  label: string;
  className?: string;
  /** "top" = palette-style (near the top, Obsidian-like); "center" = dialogs. */
  placement?: "top" | "center";
  onClose?: () => void;
  children: ReactNode;
  testId?: string;
}

export function Modal({
  label,
  className,
  placement = "center",
  onClose,
  children,
  testId,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = onClose ?? ui.closeOverlay;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>("[autofocus], input, textarea, button, [tabindex]")?.focus();
    }
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className={cx("modal-backdrop", `is-${placement}`)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx("modal", className)}
        data-testid={testId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

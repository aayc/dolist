import type { ReactNode } from "react";

/**
 * Says why the control inside is disabled. The tooltip layer skips disabled elements, so this
 * wrapper carries the reason and takes the pointer from its disabled child. No reason: the child
 * alone.
 */
export function DisabledReason({
  reason,
  children,
}: {
  reason: string | null;
  children: ReactNode;
}) {
  if (!reason) return children;
  return (
    <span className="disabled-reason" data-tooltip={reason} data-testid="disabled-reason">
      {children}
    </span>
  );
}

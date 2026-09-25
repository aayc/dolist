import type { ReactNode } from "react";

/** A settings row: its name and description on the left, its control on the right. */
export function Setting({
  name,
  description,
  children,
  testId,
}: {
  name: string;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="setting" data-testid={testId}>
      <div className="setting-info">
        <div className="setting-name">{name}</div>
        {description ? <div className="setting-description">{description}</div> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

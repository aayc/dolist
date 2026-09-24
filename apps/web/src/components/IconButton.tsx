import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  label: string;
  /** Shown in the tooltip, e.g. "⌘⇧D". */
  hotkey?: string | null;
  active?: boolean;
  size?: number;
  badge?: number;
}

export function IconButton({
  icon: Icon,
  label,
  hotkey,
  active,
  size = 16,
  badge,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const count = badge !== undefined && badge > 0 ? badge : 0;
  return (
    <button
      type={type}
      aria-label={count > 0 ? `${label} (${count} pending)` : label}
      title={hotkey ? `${label} (${hotkey})` : label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx("icon-button", active && "is-active", className)}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
      {count > 0 ? (
        <span className="icon-badge" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}

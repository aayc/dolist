import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { useServices } from "../app/services";
import type { KeyName } from "../commands/hotkeys";
import { commandLabel, commandTooltip } from "../commands/labels";
import { cx } from "../lib/cx";
import { Count } from "./Count";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  /** Its name: the accessible name and the tooltip. Defaults to the command's label. */
  label?: string;
  /** The command it runs: it names the button, and its shortcut shows in the tooltip. */
  command?: string;
  /** A key that does the same without being a command (Enter sends), shown in the tooltip. */
  keys?: KeyName;
  active?: boolean;
  size?: number;
  badge?: number;
  /** What the badge counts, joined to the name: "Open agent inbox · 2 to approve". */
  badgeLabel?: string;
}

export function IconButton({
  icon: Icon,
  label,
  command,
  keys,
  active,
  size = 16,
  badge,
  badgeLabel = "pending",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const { commands } = useServices();
  const name = label ?? (command ? commandLabel(commands, command) : "");
  const count = badge !== undefined && badge > 0 ? badge : 0;
  const text = count > 0 ? `${name} · ${count} ${badgeLabel}` : name;
  return (
    <button
      type={type}
      aria-label={text}
      aria-pressed={active}
      {...(command ? commandTooltip(commands, command, text) : { "data-tooltip": text })}
      data-tooltip-keys={keys}
      className={cx("icon-button", active && "is-active", className)}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
      {badge === undefined ? null : (
        <Count
          value={count > 99 ? "99+" : count}
          className="icon-badge"
          hidden={count === 0}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

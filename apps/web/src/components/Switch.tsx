import { cx } from "../lib/cx";

/** An on/off switch, named by `label` (its setting). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  tooltip,
  testId,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  disabled?: boolean;
  tooltip?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("switch", checked && "is-on")}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-tooltip={tooltip}
      data-testid={testId}
    >
      <span className="switch-knob" />
    </button>
  );
}

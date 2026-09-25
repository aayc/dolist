import { type InputHTMLAttributes, useLayoutEffect, useRef } from "react";
import { cx } from "../../lib/cx";
import { formatCodeInput } from "./pairing-code";

/** A pairing code field: formats as XXXX-XXXX while typing, keeping the caret in place. */
export function PairingCodeInput({
  value,
  onValue,
  className,
  ...rest
}: {
  value: string;
  onValue(value: string): void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (caret.current === null || !el || el !== document.activeElement) return;
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <input
      ref={input}
      className={cx("input pairing-code-input", className)}
      value={value}
      placeholder="XXXX-XXXX"
      autoCapitalize="characters"
      autoComplete="one-time-code"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event) => {
        const next = formatCodeInput(
          event.target.value,
          event.target.selectionStart ?? event.target.value.length,
        );
        caret.current = next.caret;
        onValue(next.value);
      }}
      {...rest}
    />
  );
}

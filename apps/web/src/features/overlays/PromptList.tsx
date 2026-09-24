import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { Modal } from "./Modal";

export interface PromptItem {
  key: string;
  render(): ReactNode;
  /** The full text, shown when the item's title or meta is cut off. */
  tooltip?: string;
}

interface PromptListProps {
  label: string;
  placeholder: string;
  query: string;
  onQueryChange(query: string): void;
  items: readonly PromptItem[];
  onChoose(index: number, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void;
  /** Extra Mod+Enter behaviour even when the list is empty (e.g. "create note"). */
  onModEnter?(): void;
  empty: ReactNode;
  footer?: ReactNode;
  testId: string;
}

/** Obsidian-style prompt: input on top, keyboard-driven result list below. */
export function PromptList({
  label,
  placeholder,
  query,
  onQueryChange,
  items,
  onChoose,
  onModEnter,
  empty,
  footer,
  testId,
}: PromptListProps) {
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A new query resets the selection to the best match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the query only
  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const clamped = Math.min(selected, Math.max(0, items.length - 1));

  return (
    <Modal label={label} placement="top" className="prompt" testId={testId}>
      <input
        className="prompt-input"
        value={query}
        placeholder={placeholder}
        // biome-ignore lint/a11y/noAutofocus: prompts are keyboard-first
        autoFocus
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded="true"
        aria-label={placeholder}
        aria-controls={`${testId}-list`}
        aria-activedescendant={items.length > 0 ? `${testId}-option-${clamped}` : undefined}
        data-testid={`${testId}-input`}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          const mod = event.metaKey || event.ctrlKey;
          if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
            event.preventDefault();
            setSelected((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
          } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
            event.preventDefault();
            setSelected((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (mod && onModEnter) onModEnter();
            else if (items.length > 0) onChoose(clamped, event);
          }
        }}
      />
      <div className="prompt-results" id={`${testId}-list`} role="listbox" ref={listRef}>
        {items.length === 0 ? <div className="prompt-empty">{empty}</div> : null}
        {items.map((item, index) => (
          <div
            key={item.key}
            id={`${testId}-option-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={index === clamped}
            data-index={index}
            data-tooltip={item.tooltip}
            data-tooltip-overflow=".prompt-item-title, .prompt-item-meta"
            data-testid={`${testId}-item`}
            className={cx("prompt-item", index === clamped && "is-selected")}
            onMouseMove={() => index !== clamped && setSelected(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => onChoose(index, event)}
          >
            {item.render()}
          </div>
        ))}
      </div>
      {footer ? <div className="prompt-footer">{footer}</div> : null}
    </Modal>
  );
}

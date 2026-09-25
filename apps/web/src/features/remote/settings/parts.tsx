import type { AgentReadiness } from "@ddl/core";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../../../components/IconButton";
import { copyText } from "../../../lib/clipboard";
import { cx } from "../../../lib/cx";
import type { ConfirmRequest, SettingsSection } from "../../../state/ui-store";
import { ui } from "../../../state/ui-store";
import { ConfirmDialog } from "../../overlays/ConfirmDialog";
import { readinessRows } from "../readiness";

/** Opens another Settings section from inside one. */
export type GoToSection = (section: SettingsSection) => void;

/** A confirmation on top of Settings (Escape closes just it): `confirm(request)` and its dialog. */
export function useConfirm(): [(request: ConfirmRequest) => void, ReactNode] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  useEffect(() => (request ? ui.stackDialog(() => setRequest(null)) : undefined), [request]);
  const dialog = request
    ? createPortal(
        <ConfirmDialog request={request} onClose={() => setRequest(null)} />,
        document.body,
      )
    : null;
  return [setRequest, dialog];
}

/** Calls `load` now and every `ms` while mounted and `enabled`. */
export function usePoll(load: () => void, ms: number, enabled = true): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (!enabled) return;
    latest.current();
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
}

/** Re-renders every `ms` (for times shown as "5 min ago" or a countdown). */
export function useNow(ms: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
  return now;
}

export function InlineError({ message, testId }: { message: string | null; testId?: string }) {
  if (!message) return null;
  return (
    <p className="settings-error" role="alert" data-testid={testId}>
      {message}
    </p>
  );
}

/** A field set by an environment variable: read-only here, and why. */
export function LockedNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="settings-locked" data-testid={testId}>
      {children}
    </p>
  );
}

export function StateChip({
  tone,
  children,
  testId,
  state,
}: {
  tone: "success" | "warning" | "danger" | "info" | "faint";
  children: ReactNode;
  testId?: string;
  state?: string;
}) {
  return (
    <span className={cx("status-chip", `tone-${tone}`)} data-testid={testId} data-state={state}>
      <span className="status-chip-dot" />
      {children}
    </span>
  );
}

/** A value to hand to another device (a code, an address), with a copy button. */
export function CopyValue({
  value,
  label,
  className,
  testId,
}: {
  value: string;
  /** What it is, for the copy button: "Copy the code". */
  label: string;
  className?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className={cx("copy-value", className)}>
      <code className="copy-value-text" data-testid={testId}>
        {value}
      </code>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? "Copied" : label}
        size={14}
        onClick={() => {
          void copyText(value).then((ok) => ok && setCopied(true));
        }}
        data-testid={testId ? `${testId}-copy` : undefined}
      />
    </span>
  );
}

const ROW_TONE = { ok: "success", warning: "warning", none: "faint" } as const;

/** A daemon's readiness to run the agent, with how to fix what's missing. */
export function Readiness({
  readiness,
  where,
  go,
  testId,
}: {
  readiness: AgentReadiness;
  where: "here" | "machine";
  go?: GoToSection;
  testId?: string;
}) {
  return (
    <dl className="readiness" data-testid={testId}>
      {readinessRows(readiness, where).map((row) => (
        <div key={row.key} className="readiness-row" data-testid={`readiness-${row.key}`}>
          <dt>{row.label}</dt>
          <dd>
            <StateChip tone={ROW_TONE[row.state]} state={row.state}>
              {row.value}
            </StateChip>
            {row.hint ? (
              <span className="readiness-hint">
                {row.hint}
                {row.section && go ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => row.section && go(row.section)}
                    >
                      Open {row.section === "computer" ? "Computer use" : "Connectors"}
                    </button>
                  </>
                ) : null}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

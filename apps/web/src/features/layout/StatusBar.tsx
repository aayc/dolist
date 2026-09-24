import type { VimModeName } from "@ddl/editor";
import { Bot, CircleAlert, LoaderCircle, ShieldAlert, TriangleAlert } from "lucide-react";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { pluralize } from "../../lib/format";
import { useAgentStore, usePendingApprovalCount } from "../../state/agent-store";
import { useConnectionStore } from "../../state/connection-store";
import { useNotesStore } from "../../state/notes-store";
import { useSettingsStore } from "../../state/settings-store";
import { useTabsStore } from "../../state/tabs-store";
import { ui } from "../../state/ui-store";
import { useVimStore } from "../../state/vim-store";
import { agentModeLabel, connectionItem, type SaveProblem, visibleSaveState } from "./status-items";

export function StatusBar() {
  const active = useTabsStore((s) => s.active);
  const saveState = useNotesStore((s) => (active ? (s.saveState[active] ?? null) : null));
  const visibleSave = visibleSaveState(saveState);
  return (
    <footer
      className="status-bar"
      data-testid="status-bar"
      data-save-state={saveState ?? undefined}
    >
      <AgentItems />
      <div className="status-spacer" />
      {visibleSave ? <SaveIndicator state={visibleSave} /> : null}
      <VimIndicator />
      <WordCount />
      <ConnectionIndicator />
    </footer>
  );
}

function AgentItems() {
  const { agent } = useServices();
  const enabled = useAgentStore((s) => s.status?.enabled ?? null);
  const rawMode = useAgentStore((s) => s.status?.mode ?? null);
  const mode = agentModeLabel(rawMode);
  const running = useAgentStore((s) => s.status?.running ?? 0);
  const queued = useAgentStore((s) => s.status?.queued ?? 0);
  const problem = useAgentStore((s) => s.status?.problem?.trim() || null);
  const pending = usePendingApprovalCount();
  const item = agentItem(enabled, rawMode === "off", problem);
  return (
    <>
      <button
        type="button"
        className={cx("status-item status-agent", `is-${item.state}`)}
        onClick={() => {
          if (item.state === "on" || item.state === "paused") void agent.setEnabled(!enabled);
          else ui.openOverlay({ kind: "settings", section: "agent" });
        }}
        aria-pressed={enabled ?? false}
        title={item.title}
        data-testid="status-agent"
        data-state={item.state}
      >
        {item.state === "unavailable" ? (
          <TriangleAlert size={13} aria-hidden="true" />
        ) : (
          <Bot size={13} aria-hidden="true" />
        )}
        <span>{item.label}</span>
        {mode && rawMode !== "off" ? <span className="status-muted">{mode}</span> : null}
      </button>
      {running + queued > 0 ? (
        <span className="status-item" data-testid="status-running" title={`${queued} queued`}>
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
          {running} running
        </span>
      ) : null}
      {pending > 0 ? (
        <button
          type="button"
          className="status-item status-approvals"
          onClick={() => ui.showInbox()}
          data-testid="status-approvals"
        >
          <ShieldAlert size={13} aria-hidden="true" />
          {pending} to approve
        </button>
      ) : null}
    </>
  );
}

type AgentItemState = "unknown" | "on" | "paused" | "off" | "unavailable";

/** One agent item that never says "on" while the agent can't act (same wording as the Mac app). */
function agentItem(
  enabled: boolean | null,
  off: boolean,
  problem: string | null,
): { state: AgentItemState; label: string; title: string } {
  if (enabled === null) return { state: "unknown", label: "Agent", title: "Agent status unknown" };
  if (off)
    return { state: "off", label: "Agent off", title: problem ?? "The agent is turned off." };
  if (problem) return { state: "unavailable", label: "Agent unavailable", title: problem };
  return enabled
    ? {
        state: "on",
        label: "Agent on",
        title: "The agent is watching your daily notes. Click to pause.",
      }
    : { state: "paused", label: "Agent paused", title: "The agent is paused. Click to resume." };
}

const SAVE_LABELS: Record<SaveProblem, string> = {
  dirty: "Unsaved",
  saving: "Saving…",
  conflict: "Conflict",
  error: "Save failed",
};

function SaveIndicator({ state }: { state: SaveProblem }) {
  const Icon = state === "error" ? CircleAlert : state === "conflict" ? TriangleAlert : null;
  return (
    <span
      className={cx("status-item status-save", `is-${state}`)}
      data-testid="status-save"
      data-state={state}
    >
      {Icon ? (
        <Icon size={12} aria-hidden="true" />
      ) : (
        <span className="save-dot" aria-hidden="true" />
      )}
      {SAVE_LABELS[state]}
    </span>
  );
}

const VIM_MODES: Record<VimModeName, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  replace: "REPLACE",
  visual: "VISUAL",
  "visual-line": "V-LINE",
  "visual-block": "V-BLOCK",
};

/** Vim's mode line: pending keys ("showcmd"), macro recording, and the mode. */
function VimIndicator() {
  const enabled = useSettingsStore((s) => s.settings.editor.vimMode);
  const status = useVimStore((s) => s.status);
  if (!enabled) return null;
  return (
    <span
      className={cx("status-item status-vim", status && `is-${status.mode}`)}
      data-testid="status-vim"
      data-mode={status?.mode ?? ""}
      title="Vim mode"
    >
      {status?.recording ? (
        <span className="status-vim-recording" data-testid="status-vim-recording">
          recording @{status.recording}
        </span>
      ) : null}
      {status?.pending ? (
        <span className="status-vim-pending" data-testid="status-vim-pending">
          {status.pending}
        </span>
      ) : null}
      <span className="status-vim-mode">{status ? VIM_MODES[status.mode] : "VIM"}</span>
    </span>
  );
}

function WordCount() {
  const hasNote = useTabsStore((s) => s.active !== null);
  const count = useNotesStore((s) => s.wordCount);
  if (!hasNote || count === null) return null;
  return (
    <span className="status-item status-words" data-testid="status-words">
      {pluralize(count, "word")}
    </span>
  );
}

function ConnectionIndicator() {
  const state = useConnectionStore((s) => s.state);
  const kind = useConnectionStore((s) => s.kind);
  const item = connectionItem(state, kind);
  if (!item) return null;
  return (
    <span
      className={cx("status-item status-connection", `is-${state}`, kind === "mock" && "is-mock")}
      data-testid="status-connection"
      data-state={state}
      title={item.title}
    >
      <span className="connection-dot" aria-hidden="true" />
      {item.label}
    </span>
  );
}

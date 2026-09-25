import type { VimModeName } from "@ddl/editor";
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  MonitorX,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
} from "lucide-react";
import { useServices } from "../../app/services";
import { commandTooltip } from "../../commands/labels";
import { Count } from "../../components/Count";
import { cx } from "../../lib/cx";
import { pluralize } from "../../lib/format";
import { useAgentStore, usePendingApprovalCount } from "../../state/agent-store";
import { useConnectionStore } from "../../state/connection-store";
import { useNotesStore } from "../../state/notes-store";
import { useSettingsStore } from "../../state/settings-store";
import { useTabsStore } from "../../state/tabs-store";
import { ui } from "../../state/ui-store";
import { useVimStore } from "../../state/vim-store";
import { approvalPolicyItem } from "../settings/approval-policy";
import {
  agentItem,
  agentModeLabel,
  computerItem,
  connectionItem,
  runningItem,
  type SaveProblem,
  visibleSaveState,
} from "./status-items";

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
  const { agent, commands } = useServices();
  const enabled = useAgentStore((s) => s.status?.enabled ?? null);
  const rawMode = useAgentStore((s) => s.status?.mode ?? null);
  const mode = agentModeLabel(rawMode);
  const running = useAgentStore((s) => s.status?.running ?? 0);
  const queued = useAgentStore((s) => s.status?.queued ?? 0);
  const problem = useAgentStore((s) => s.status?.problem?.trim() || null);
  const access = useAgentStore((s) => s.status?.execution.computerAccess);
  const pending = usePendingApprovalCount();
  const item = agentItem(enabled, rawMode === "off", problem);
  const work = runningItem(running, queued);
  const computer = computerItem(access, item.state === "on");
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
        data-tooltip={item.title}
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
      {work ? (
        <span className="status-item" data-testid="status-running" data-tooltip={work.title}>
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
          {work.label}
        </span>
      ) : null}
      {pending > 0 ? (
        <button
          type="button"
          className="status-item status-approvals"
          onClick={() => ui.showInbox()}
          {...commandTooltip(commands, "agent:inbox")}
          data-testid="status-approvals"
        >
          <ShieldAlert size={13} aria-hidden="true" />
          <Count value={pending} className="status-count" /> to approve
        </button>
      ) : null}
      {computer ? (
        <button
          type="button"
          className="status-item status-computer"
          onClick={() => commands.run("settings:computer")}
          {...commandTooltip(commands, "settings:computer", computer.title)}
          data-testid="status-computer"
        >
          <MonitorX size={13} aria-hidden="true" />
          {computer.label}
        </button>
      ) : null}
      <ApprovalPolicyIndicator />
    </>
  );
}

/** The approval policy while it isn't the default; opens Settings → Agent. */
function ApprovalPolicyIndicator() {
  const { commands } = useServices();
  const approvalPolicy = useSettingsStore((s) => s.settings.agent.approvalPolicy);
  const item = approvalPolicyItem({ approvalPolicy });
  if (!item) return null;
  const Icon = item.tone === "warning" ? ShieldOff : ShieldCheck;
  return (
    <button
      type="button"
      className={cx("status-item status-approval-policy", `is-${item.tone}`)}
      onClick={() => commands.run("settings:approvals")}
      {...commandTooltip(commands, "settings:approvals", item.title)}
      data-testid="status-approval-policy"
      data-tone={item.tone}
    >
      <Icon size={13} aria-hidden="true" />
      {item.label}
    </button>
  );
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
      data-tooltip="Vim mode"
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
      data-tooltip={item.title}
    >
      <span className="connection-dot" aria-hidden="true" />
      {item.label}
    </span>
  );
}

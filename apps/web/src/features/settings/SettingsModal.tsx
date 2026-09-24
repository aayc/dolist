import type { ConnectorStatus, ThemePreference } from "@ddl/core";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { cx } from "../../lib/cx";
import { useAgentStore } from "../../state/agent-store";
import { useConnectionStore } from "../../state/connection-store";
import { useSettingsStore } from "../../state/settings-store";
import { type SettingsSection, ui } from "../../state/ui-store";
import { useVaultStore } from "../../state/vault-store";
import { Modal } from "../overlays/Modal";
import { dailyPreview } from "./daily-preview";
import "../../styles/settings.css";

const SECTIONS: ReadonlyArray<{ key: SettingsSection; label: string }> = [
  { key: "general", label: "Appearance" },
  { key: "editor", label: "Editor" },
  { key: "daily", label: "Daily notes" },
  { key: "agent", label: "Agent" },
  { key: "connectors", label: "Connectors" },
  { key: "about", label: "About" },
];

export function SettingsModal({ section }: { section: SettingsSection }) {
  const [active, setActive] = useState(section);
  return (
    <Modal label="Settings" className="settings-modal" testId="settings-modal">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={cx("settings-nav-item", active === key && "is-active")}
            aria-current={active === key ? "page" : undefined}
            onClick={() => setActive(key)}
            data-testid={`settings-nav-${key}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <div className="settings-close">
          <IconButton icon={X} label="Close settings" onClick={() => ui.closeOverlay()} />
        </div>
        {active === "general" ? <AppearanceSection /> : null}
        {active === "editor" ? <EditorSection /> : null}
        {active === "daily" ? <DailySection /> : null}
        {active === "agent" ? <AgentSection /> : null}
        {active === "connectors" ? <ConnectorsSection /> : null}
        {active === "about" ? <AboutSection /> : null}
      </div>
    </Modal>
  );
}

function Setting({
  name,
  description,
  children,
}: {
  name: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting">
      <div className="setting-info">
        <div className="setting-name">{name}</div>
        {description ? <div className="setting-description">{description}</div> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("toggle", checked && "is-on")}
      onClick={() => onChange(!checked)}
      data-testid={testId}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/** Text input that commits after typing pauses (and on blur), keeping a live local draft. */
function DraftInput({
  value,
  onCommit,
  onDraft,
  label,
  testId,
  placeholder,
}: {
  value: string;
  onCommit(value: string): void;
  onDraft?(value: string): void;
  label: string;
  testId?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onCommit(draft), 500);
    return () => clearTimeout(timer);
  }, [draft, value, onCommit]);
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      data-testid={testId}
      onChange={(event) => {
        setDraft(event.target.value);
        onDraft?.(event.target.value);
      }}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
  label,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit(value: number): void;
  label: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return setDraft(String(value));
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      className="input input-number"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-label={label}
      data-testid={testId}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && commit()}
    />
  );
}

function AppearanceSection() {
  const { updateSettings } = useServices();
  const theme = useSettingsStore((s) => s.settings.theme);
  const options: ThemePreference[] = ["system", "light", "dark"];
  return (
    <section>
      <h2 className="settings-heading">Appearance</h2>
      <Setting name="Theme" description="Follow the system, or pick light or dark.">
        <fieldset className="segmented">
          <legend className="sr-only">Theme</legend>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              className={cx("segmented-item", theme === option && "is-active")}
              onClick={() => void updateSettings({ theme: option })}
              data-testid={`theme-${option}`}
            >
              {option.charAt(0).toUpperCase() + option.slice(1)}
            </button>
          ))}
        </fieldset>
      </Setting>
    </section>
  );
}

function EditorSection() {
  const { updateSettings } = useServices();
  const editor = useSettingsStore((s) => s.settings.editor);
  const set = (patch: Partial<typeof editor>) => void updateSettings({ editor: patch });
  return (
    <section>
      <h2 className="settings-heading">Editor</h2>
      <Setting name="Vim key bindings" description="Use Vim keys in the editor.">
        <Toggle
          checked={editor.vimMode}
          onChange={(vimMode) => set({ vimMode })}
          label="Vim key bindings"
          testId="setting-vim"
        />
      </Setting>
      <Setting name="Live preview" description="Hide markdown syntax away from the cursor.">
        <Toggle
          checked={editor.livePreview}
          onChange={(livePreview) => set({ livePreview })}
          label="Live preview"
        />
      </Setting>
      <Setting name="Readable line length" description="Limit line width and center the text.">
        <Toggle
          checked={editor.readableLineLength}
          onChange={(readableLineLength) => set({ readableLineLength })}
          label="Readable line length"
          testId="setting-readable"
        />
      </Setting>
      <Setting name="Font size" description="Editor font size in pixels.">
        <NumberInput
          value={editor.fontSize}
          min={10}
          max={32}
          onCommit={(fontSize) => set({ fontSize })}
          label="Font size"
          testId="setting-font-size"
        />
      </Setting>
      <Setting name="Spellcheck">
        <Toggle
          checked={editor.spellcheck}
          onChange={(spellcheck) => set({ spellcheck })}
          label="Spellcheck"
        />
      </Setting>
      <Setting name="Line numbers">
        <Toggle
          checked={editor.showLineNumbers}
          onChange={(showLineNumbers) => set({ showLineNumbers })}
          label="Line numbers"
        />
      </Setting>
    </section>
  );
}

function DailySection() {
  const { updateSettings } = useServices();
  const daily = useSettingsStore((s) => s.settings.dailyNotes);
  const files = useVaultStore((s) => s.files);
  const [draft, setDraft] = useState(daily);
  useEffect(() => setDraft(daily), [daily]);
  const preview = dailyPreview(draft, files);
  return (
    <section>
      <h2 className="settings-heading">Daily notes</h2>
      <Setting name="Folder" description="New daily notes are created here.">
        <DraftInput
          value={daily.folder}
          label="Daily notes folder"
          placeholder="Vault root"
          testId="setting-daily-folder"
          onDraft={(folder) => setDraft((d) => ({ ...d, folder }))}
          onCommit={(folder) => void updateSettings({ dailyNotes: { folder } })}
        />
      </Setting>
      <Setting
        name="Date format"
        description="Moment.js tokens, e.g. YYYY-MM-DD or YYYY/MM/YYYY-MM-DD."
      >
        <DraftInput
          value={daily.format}
          label="Daily note date format"
          testId="setting-daily-format"
          onDraft={(format) => setDraft((d) => ({ ...d, format }))}
          onCommit={(format) => void updateSettings({ dailyNotes: { format } })}
        />
      </Setting>
      <Setting name="Template" description="Note used as the starting content of new daily notes.">
        <DraftInput
          value={daily.template}
          label="Daily note template"
          placeholder="No template"
          testId="setting-daily-template"
          onDraft={(template) => setDraft((d) => ({ ...d, template }))}
          onCommit={(template) => void updateSettings({ dailyNotes: { template } })}
        />
      </Setting>
      <div className={cx("daily-preview", preview.error && "is-error")} data-testid="daily-preview">
        {preview.error ? (
          preview.error
        ) : (
          <>
            Today's note: <code>{preview.path}</code>
            {preview.templateMissing ? <span className="muted"> · template not found</span> : null}
          </>
        )}
      </div>
    </section>
  );
}

function AgentSection() {
  const { updateSettings, agent } = useServices();
  const settings = useSettingsStore((s) => s.settings.agent);
  const status = useAgentStore((s) => s.status);
  const enabled = status?.enabled ?? settings.enabled;
  return (
    <section>
      <h2 className="settings-heading">Agent</h2>
      {status?.problem ? <div className="settings-problem">{status.problem}</div> : null}
      <Setting name="Agent enabled" description="When off, the orchestrator ignores note changes.">
        <Toggle
          checked={enabled}
          onChange={(value) => {
            void agent.setEnabled(value);
            void updateSettings({ agent: { enabled: value } });
          }}
          label="Agent enabled"
          testId="setting-agent-enabled"
        />
      </Setting>
      <Setting
        name="Settle delay"
        description="Quiet time (ms) after you stop editing a task before the agent looks at it."
      >
        <NumberInput
          value={settings.settleMs}
          min={250}
          max={60_000}
          step={250}
          onCommit={(settleMs) => void updateSettings({ agent: { settleMs } })}
          label="Settle delay in milliseconds"
          testId="setting-settle"
        />
      </Setting>
      <Setting name="Max concurrent subagents">
        <NumberInput
          value={settings.maxConcurrentSubagents}
          min={1}
          max={16}
          onCommit={(maxConcurrentSubagents) =>
            void updateSettings({ agent: { maxConcurrentSubagents } })
          }
          label="Max concurrent subagents"
          testId="setting-max-subagents"
        />
      </Setting>
      <Setting name="Model" description="Configured on the daemon (OpenRouter model id).">
        <code className="settings-value">{status?.model ?? settings.model}</code>
      </Setting>
      <Setting name="Safety judge model">
        <code className="settings-value">{settings.judgeModel}</code>
      </Setting>
    </section>
  );
}

const STATE_TONE: Record<ConnectorStatus["state"], string> = {
  connected: "success",
  connecting: "info",
  idle: "faint",
  disabled: "faint",
  error: "danger",
};

function ConnectorsSection() {
  const { client } = useServices();
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    client.getConnectors().then(
      (list) => !cancelled && setConnectors(list),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  return (
    <section>
      <h2 className="settings-heading">Connectors</h2>
      <p className="settings-hint">
        MCP servers from <code>~/.daily-do-list/mcp.json</code> (same format as Claude Desktop and
        Cursor).
      </p>
      {error ? <div className="search-error">{error}</div> : null}
      {connectors === null && !error ? <div className="thread-loading" aria-busy="true" /> : null}
      {connectors?.length === 0 ? <p className="muted">No connectors configured.</p> : null}
      <ul className="connector-list" data-testid="connector-list">
        {connectors?.map((connector) => (
          <li key={connector.name} className="connector">
            <span className="connector-name">{connector.name}</span>
            <span className="chip">{connector.transport}</span>
            <span className="connector-tools">{connector.toolCount} tools</span>
            <span className={cx("status-chip", `tone-${STATE_TONE[connector.state]}`)}>
              <span className="status-chip-dot" />
              {connector.state}
            </span>
            {connector.error ? <span className="connector-error">{connector.error}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AboutSection() {
  const connection = useConnectionStore();
  const status = useAgentStore((s) => s.status);
  const rows: Array<[string, ReactNode]> = [
    ["Daemon", connection.kind === "mock" ? "In-browser mock (no daemon)" : connection.endpoint],
    ["Connection", connection.state],
    ["Vault", connection.health?.vaultName ?? "—"],
    ["Agent mode", status?.mode ?? connection.health?.agentMode ?? "—"],
    ["Execution", status ? `${status.execution.provider}` : "—"],
    ["Server version", connection.health?.version ?? "—"],
    ["API version", connection.health ? String(connection.health.apiVersion) : "—"],
    ["App version", __APP_VERSION__],
  ];
  return (
    <section>
      <h2 className="settings-heading">About</h2>
      <dl className="about-list" data-testid="about-list">
        {rows.map(([label, value]) => (
          <div key={label} className="about-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

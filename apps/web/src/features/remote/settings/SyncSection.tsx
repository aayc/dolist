import type { DeviceSyncSetup, SyncStatusResponse } from "@ddl/core";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { useServices } from "../../../app/services";
import { pluralize } from "../../../lib/format";
import { applyDevice, loadDevice, useDeviceStore } from "../device-store";
import { syncTokenProblem, syncUrlProblem, syncVaultProblem } from "../inputs";
import { remoteErrorMessage } from "../remote-errors";
import { timeAgo } from "../time";
import { InlineError, LockedNote, StateChip, useConfirm, useNow, usePoll } from "./parts";

/** While the section is open, the sync status is read this often. */
const POLL_MS = 3_000;
const SAVED_MS = 2_500;

const STATE_CHIP: Record<
  SyncStatusResponse["state"],
  { tone: "success" | "info" | "danger" | "faint"; label: string }
> = {
  idle: { tone: "success", label: "Up to date" },
  syncing: { tone: "info", label: "Syncing…" },
  error: { tone: "danger", label: "Can't sync" },
  disabled: { tone: "faint", label: "Off" },
};

const TARGETS: Record<SyncStatusResponse["target"], string> = {
  none: "Nowhere",
  local: "A folder (set in config.json)",
  s3: "S3 (set in config.json)",
  remote: "The sync service",
};

/** Settings → Sync: this device's link to the sync service, and how syncing goes. */
export function SyncSection() {
  const { client } = useServices();
  const device = useDeviceStore((s) => s.device);
  const loadError = useDeviceStore((s) => s.loadError);
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const loadStatus = useCallback(() => {
    client.getSyncStatus().then(setStatus, () => {});
  }, [client]);
  useEffect(() => {
    void loadDevice(client, true);
  }, [client]);
  usePoll(loadStatus, POLL_MS);

  return (
    <section data-testid="settings-sync">
      <h2 className="settings-heading">Sync</h2>
      <p className="settings-hint">
        Sync this vault with your sync service so your other devices and the always-on machine get
        your notes, and the agent can move between them. Each device keeps its own folder.
      </p>
      {status ? <SyncStatusRows status={status} /> : null}
      {!device ? (
        loadError ? (
          <InlineError message={loadError} testId="sync-load-error" />
        ) : (
          <div className="thread-loading" aria-busy="true" />
        )
      ) : (
        <>
          {device.lockedByEnv.includes("sync") ? (
            <LockedNote testId="sync-locked">
              DDL_SYNC_URL, DDL_SYNC_VAULT or DDL_SYNC_TOKEN set this device&apos;s sync: change
              them there.
            </LockedNote>
          ) : null}
          <SyncForm
            setup={device.sync}
            locked={device.lockedByEnv.includes("sync")}
            onSaved={loadStatus}
          />
        </>
      )}
    </section>
  );
}

function SyncStatusRows({ status }: { status: SyncStatusResponse }) {
  const now = useNow(15_000);
  const chip = STATE_CHIP[status.state];
  return (
    <dl className="about-list" data-testid="sync-status">
      <div className="about-row">
        <dt>Status</dt>
        <dd>
          <StateChip tone={chip.tone} state={status.state} testId="sync-state">
            {chip.label}
          </StateChip>
          {status.lastError ? (
            <div className="settings-error" data-testid="sync-last-error">
              {status.lastError}
            </div>
          ) : null}
        </dd>
      </div>
      {status.state === "disabled" ? null : (
        <>
          <div className="about-row">
            <dt>Syncs with</dt>
            <dd data-testid="sync-target">
              {status.target === "remote" && status.remoteHost
                ? status.remoteHost
                : TARGETS[status.target]}
              {status.deviceName ? (
                <div className="muted">This device is “{status.deviceName}” to the others.</div>
              ) : null}
            </dd>
          </div>
          <div className="about-row">
            <dt>Last synced</dt>
            <dd data-testid="sync-last">
              {status.lastSyncedAt === null ? "Not yet" : timeAgo(status.lastSyncedAt, now)}
              {status.pendingChanges > 0
                ? ` · ${pluralize(status.pendingChanges, "change")} waiting`
                : ""}
            </dd>
          </div>
          {status.conflicts.length > 0 ? (
            <div className="about-row">
              <dt>Conflicts</dt>
              <dd data-testid="sync-conflicts">
                {pluralize(status.conflicts.length, "conflict copy", "conflict copies")} to resolve
                <ul className="sync-conflicts">
                  {status.conflicts.slice(0, 3).map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </>
      )}
    </dl>
  );
}

function SyncForm({
  setup,
  locked,
  onSaved,
}: {
  setup: DeviceSyncSetup;
  locked: boolean;
  onSaved(): void;
}) {
  const { client } = useServices();
  const [url, setUrl] = useState(setup.url ?? "");
  const [vault, setVault] = useState(setup.vault ?? "");
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState<"save" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, dialog] = useConfirm();
  const ids = useId();
  // Saved or turned off (here or by another client): the fields show the setup now.
  useEffect(() => {
    setUrl(setup.url ?? "");
    setVault(setup.vault ?? "");
  }, [setup.url, setup.vault]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const on = setup.url !== null;
  const problems = {
    url: syncUrlProblem(url),
    vault: syncVaultProblem(vault),
    token: syncTokenProblem(token, setup.hasToken),
  };
  const changed =
    url.trim() !== (setup.url ?? "") || vault.trim() !== (setup.vault ?? "") || token.trim() !== "";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    if (problems.url || problems.vault || problems.token) return;
    setBusy("save");
    setError(null);
    try {
      const device = await client.setupSync({
        url: url.trim(),
        vault: vault.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setToken("");
      setSaved(true);
      applyDevice(device);
      onSaved();
    } catch (e) {
      setError(remoteErrorMessage(e, "sync"));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    setBusy("off");
    setError(null);
    try {
      applyDevice(await client.removeSync());
      onSaved();
    } catch (e) {
      setError(remoteErrorMessage(e, "syncOff"));
    } finally {
      setBusy(null);
    }
  };

  const invalid = (field: keyof typeof problems) => shown && problems[field] !== null;
  const note = (field: keyof typeof problems, hint: ReactNode) =>
    invalid(field) ? (
      <span
        className="remote-field-error"
        id={`${ids}-${field}-note`}
        data-testid={`sync-${field}-problem`}
      >
        {problems[field]}
      </span>
    ) : (
      <span className="remote-field-hint" id={`${ids}-${field}-note`}>
        {hint}
      </span>
    );

  return (
    <form className="remote-form" onSubmit={save} noValidate data-testid="sync-form">
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={`${ids}-url`}>
          Sync service
        </label>
        <input
          id={`${ids}-url`}
          className="input"
          type="url"
          value={url}
          placeholder="https://vm-name.tailnet-name.ts.net:8443"
          spellCheck={false}
          autoComplete="off"
          disabled={locked}
          aria-invalid={invalid("url")}
          aria-describedby={`${ids}-url-note`}
          data-testid="sync-url"
          onChange={(event) => setUrl(event.target.value)}
        />
        {note("url", "Where your sync service runs, for example on the always-on machine.")}
      </div>
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={`${ids}-vault`}>
          Vault
        </label>
        <input
          id={`${ids}-vault`}
          className="input"
          value={vault}
          placeholder="vault id"
          spellCheck={false}
          autoComplete="off"
          disabled={locked}
          aria-invalid={invalid("vault")}
          aria-describedby={`${ids}-vault-note`}
          data-testid="sync-vault"
          onChange={(event) => setVault(event.target.value)}
        />
        {note("vault", "The vault id the sync service gave when the vault was created.")}
      </div>
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={`${ids}-token`}>
          Vault token
          {setup.hasToken ? (
            <StateChip tone="success" state="saved" testId="sync-token-saved">
              Saved
            </StateChip>
          ) : null}
        </label>
        <input
          id={`${ids}-token`}
          className="input"
          type="password"
          value={token}
          placeholder={setup.hasToken ? "Leave empty to keep the saved token" : "Paste the token"}
          spellCheck={false}
          autoComplete="new-password"
          disabled={locked}
          aria-invalid={invalid("token")}
          aria-describedby={`${ids}-token-note`}
          data-testid="sync-token"
          onChange={(event) => setToken(event.target.value)}
        />
        {note("token", "Kept on this device only, never synced and never shown again.")}
      </div>
      <InlineError message={error} testId="sync-error" />
      {locked ? null : (
        <div className="remote-actions">
          <button
            type="submit"
            className="button is-primary"
            disabled={busy !== null || (on && !changed)}
            data-testid="sync-save"
          >
            {busy === "save" ? "Saving…" : on ? "Save" : "Turn on sync"}
          </button>
          {on ? (
            <button
              type="button"
              className="button is-danger-ghost"
              disabled={busy !== null}
              data-testid="sync-off"
              onClick={() =>
                confirm({
                  title: "Turn off sync on this device?",
                  message:
                    "This device stops syncing and its saved vault token is deleted. Its notes stay in its folder, and your other devices keep syncing.",
                  confirmLabel: "Turn off",
                  danger: true,
                  onConfirm: () => void turnOff(),
                })
              }
            >
              {busy === "off" ? "Turning off…" : "Turn off sync"}
            </button>
          ) : null}
          {saved ? (
            <span className="settings-success" role="status" data-testid="sync-saved">
              Saved
            </span>
          ) : null}
        </div>
      )}
      {dialog}
    </form>
  );
}

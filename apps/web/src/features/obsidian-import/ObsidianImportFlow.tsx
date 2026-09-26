import type {
  DeviceVaultResponse,
  ObsidianImportJob,
  ObsidianImportPreview,
  SyncStatusResponse,
} from "@ddl/core";
import { formatBytes, pluralize } from "@ddl/core";
import { type FormEvent, useState } from "react";
import { VaultSwitchOverlay } from "../../app/lazy";
import { useServices } from "../../app/services";
import { DisabledReason } from "../../components/DisabledReason";
import { applyImportJob, useObsidianImportStore } from "../../state/obsidian-import-store";
import { CarryOver, PreviewReport } from "./ImportReport";
import {
  type ImportProblem,
  importProblem,
  PHASE_LABEL,
  progressFraction,
  progressText,
} from "./import-text";
import { requestVaultSwitch } from "./vault-switch";

export interface ImportFlowProps {
  vault: DeviceVaultResponse | null;
  sync: SyncStatusResponse | null;
  /** Why nothing here can be done from this device (a paired device), or null. */
  disabledReason: string | null;
  /** Asks the daemon again where things stand (after a 409 or 404). */
  refresh(): void;
  onOpenSync?: () => void;
}

function Problem({ problem, testId }: { problem: ImportProblem | null; testId: string }) {
  if (!problem) return null;
  return (
    <div className="settings-problem" role="alert" data-testid={testId}>
      {problem.message}
    </div>
  );
}

export function ProgressBar({ job }: { job: ObsidianImportJob }) {
  const fraction = progressFraction(job);
  return (
    <div className="import-progress" data-testid="import-progress">
      <div className="import-progress-head">
        <span data-testid="import-phase">{PHASE_LABEL[job.phase] ?? job.phase}</span>
        <span className="muted" data-testid="import-counts">
          {progressText(job)}
        </span>
      </div>
      <div
        className="import-progress-track"
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div className="import-progress-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Settings → Vault → Import from Obsidian: the Obsidian vault's path, the report, the new vault's
 * folder, the import with its progress, then the switch.
 */
export function ObsidianImportFlow(props: ImportFlowProps) {
  const { client } = useServices();
  const { disabledReason, refresh } = props;
  const job = useObsidianImportStore((s) => s.job);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ObsidianImportPreview | null>(null);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | "cancel" | null>(null);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  /** A finished import the user moved on from ("Start over"). */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const current = job?.kind === "import" && job.id !== dismissed ? job : null;
  const otherRunning = job?.kind === "update" && job.state === "running";

  const readReport = async (event: FormEvent) => {
    event.preventDefault();
    if (!source.trim() || disabledReason) return;
    setBusy("preview");
    setProblem(null);
    try {
      const report = await client.previewObsidianImport(source.trim());
      setPreview(report);
      setDestination(report.defaultDestination);
    } catch (error) {
      setPreview(null);
      setProblem(importProblem(error));
    } finally {
      setBusy(null);
    }
  };

  const startImport = async () => {
    if (!preview || disabledReason) return;
    setBusy("import");
    setProblem(null);
    try {
      const target = destination.trim();
      const response = await client.startObsidianImport({
        source: preview.source,
        ...(target ? { destination: target } : {}),
      });
      applyImportJob(response.job);
    } catch (error) {
      const found = importProblem(error);
      setProblem(found);
      if (found.status === 409) refresh();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      applyImportJob((await client.cancelObsidianImport()).job);
    } catch (error) {
      setProblem(importProblem(error));
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const startOver = () => {
    if (current) setDismissed(current.id);
    setProblem(null);
  };

  if (current) {
    return (
      <div className="import-flow" data-testid="import-flow">
        <p className="report-line">
          From <code>{current.source}</code> into <code>{current.destination}</code>
        </p>
        {current.state === "running" ? (
          <>
            <ProgressBar job={current} />
            <div className="import-actions">
              <button
                type="button"
                className="button"
                onClick={() => void cancel()}
                disabled={busy === "cancel"}
                data-tooltip="Stop and remove what was copied so far"
                data-testid="import-cancel"
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          </>
        ) : null}
        {current.state === "done" && current.result ? (
          <ImportResult job={current} {...props} />
        ) : null}
        {current.state === "failed" || current.state === "cancelled" ? (
          <div className="settings-problem" data-testid="import-stopped">
            {current.state === "failed"
              ? `The import stopped: ${current.error ?? "an unexpected error"}.`
              : "The import was cancelled."}{" "}
            Nothing was left behind, and your vaults are as they were.
          </div>
        ) : null}
        <Problem problem={problem} testId="import-problem" />
        {current.state === "running" ? null : (
          <button
            type="button"
            className="link-button"
            onClick={startOver}
            data-testid="import-start-over"
          >
            {current.state === "done" ? "Import another vault" : "Start over"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="import-flow" data-testid="import-flow">
      <ol className="import-steps">
        <li className="import-step">
          <h4 className="import-step-title">Your Obsidian vault</h4>
          <p className="settings-hint">
            Paste the path of your Obsidian vault: the folder with <code>.obsidian</code> inside. In
            Finder, hold Option while you right-click the folder and choose Copy as Pathname.
          </p>
          <p className="settings-hint">
            Daily Do List only reads it, and copies it into a new vault, so Obsidian and Obsidian
            Sync go on using the original. If it&apos;s in iCloud Drive, download it first (Keep
            Downloaded).
          </p>
          <form className="import-row" onSubmit={(event) => void readReport(event)}>
            <input
              className="input"
              value={source}
              placeholder="~/Documents/Obsidian Vault"
              aria-label="Obsidian vault folder"
              spellCheck={false}
              autoComplete="off"
              disabled={Boolean(disabledReason)}
              onChange={(event) => {
                setSource(event.target.value);
                setPreview(null);
                setProblem(null);
              }}
              data-testid="import-source"
            />
            <DisabledReason reason={disabledReason}>
              <button
                type="submit"
                className="button"
                disabled={Boolean(disabledReason) || !source.trim() || busy === "preview"}
                data-testid="import-preview"
              >
                {busy === "preview" ? "Reading…" : "Preview"}
              </button>
            </DisabledReason>
          </form>
          {preview ? null : <Problem problem={problem} testId="import-problem" />}
        </li>
        {preview ? (
          <>
            <li className="import-step">
              <h4 className="import-step-title">
                What comes over from {preview.isObsidianVault ? "the Obsidian vault" : "the folder"}
              </h4>
              <PreviewReport preview={preview} />
            </li>
            <li className="import-step">
              <h4 className="import-step-title">Where the new vault goes</h4>
              <p className="settings-hint">
                A new folder, or an empty one, outside the Obsidian vault.{" "}
                {pluralize(preview.files, "file")} ({formatBytes(preview.bytes)}) are copied into it
                as they are, so it still opens in Obsidian.
              </p>
              <div className="import-row">
                <input
                  className="input"
                  value={destination}
                  aria-label="New vault folder"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setDestination(event.target.value)}
                  data-testid="import-destination"
                />
                <DisabledReason reason={otherRunning ? "An update from Obsidian is running" : null}>
                  <button
                    type="button"
                    className="button is-primary"
                    onClick={() => void startImport()}
                    disabled={busy === "import" || otherRunning || !destination.trim()}
                    data-testid="import-start"
                  >
                    {busy === "import" ? "Starting…" : "Import"}
                  </button>
                </DisabledReason>
              </div>
              <Problem problem={problem} testId="import-problem" />
            </li>
          </>
        ) : null}
      </ol>
    </div>
  );
}

/** The finished import, then the switch to the new vault. */
function ImportResult({
  job,
  vault,
  sync,
  disabledReason,
  refresh,
  onOpenSync,
}: ImportFlowProps & { job: ObsidianImportJob }) {
  const services = useServices();
  const [switching, setSwitching] = useState(false);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const result = job.result!;
  const syncing = sync !== null && sync.target !== "none";
  const lockedByEnv = vault?.lockedByEnv ?? false;
  const blocked =
    disabledReason ??
    (lockedByEnv ? "DDL_VAULT sets the vault" : null) ??
    (syncing ? "Turn sync off first" : null);

  const switchNow = async () => {
    setSwitching(true);
    setProblem(null);
    try {
      const response = await requestVaultSwitch(
        {
          client: services.client,
          flush: () => services.workspace.notes.flushAll(),
          preload: () => VaultSwitchOverlay.preload(),
        },
        job.destination,
        vault?.path ?? result.carryOver.vault,
      );
      if (!response.restart) setProblem({ message: "Daily Do List is already on this vault." });
    } catch (error) {
      const found = importProblem(error);
      setProblem(found);
      if (found.status === 409) refresh();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="import-result" data-testid="import-result">
      <p className="report-line">
        <strong>Imported.</strong> {pluralize(result.copied.files, "file")} (
        {formatBytes(result.copied.bytes)}) were copied, and your Daily Do List notes carried over.
      </p>
      <details className="report-fold">
        <summary>What was carried over</summary>
        <CarryOver plan={result.carryOver} />
      </details>
      <h4 className="import-step-title">Switch to the new vault</h4>
      <p className="settings-hint">
        Daily Do List restarts on <code>{job.destination}</code>, and this page reconnects by
        itself. Your current vault stays at <code>{vault?.path ?? result.carryOver.vault}</code>,
        untouched: it&apos;s your backup.
      </p>
      {lockedByEnv ? (
        <div className="settings-problem" data-testid="switch-locked">
          The daemon was started with <code>DDL_VAULT</code>, which fixes its vault. To switch, set{" "}
          <code>DDL_VAULT</code> to <code>{job.destination}</code> where you start it, then start it
          again.
        </div>
      ) : null}
      {syncing && !lockedByEnv ? (
        <div className="settings-problem" data-testid="switch-syncing">
          This device syncs its vault. Turn sync off first
          {onOpenSync ? (
            <>
              {" "}
              in{" "}
              <button type="button" className="link-button" onClick={onOpenSync}>
                Settings → Sync
              </button>
            </>
          ) : (
            " (Settings → Sync)"
          )}
          , or your old notes would sync into the new vault. You can sync the new vault afterwards.{" "}
          <button type="button" className="link-button" onClick={refresh}>
            Check again
          </button>
        </div>
      ) : null}
      <div className="import-actions">
        <DisabledReason reason={blocked}>
          <button
            type="button"
            className="button is-primary"
            onClick={() => void switchNow()}
            disabled={switching || blocked !== null}
            data-testid="switch-vault"
          >
            {switching ? "Switching…" : "Switch to the new vault"}
          </button>
        </DisabledReason>
      </div>
      <Problem problem={problem} testId="switch-problem" />
    </div>
  );
}

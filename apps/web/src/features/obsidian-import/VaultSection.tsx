import type { DeviceVaultResponse, ObsidianImportOrigin, SyncStatusResponse } from "@ddl/core";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { DisabledReason } from "../../components/DisabledReason";
import { IconButton } from "../../components/IconButton";
import { copyText } from "../../lib/clipboard";
import { useConnectionStore } from "../../state/connection-store";
import {
  applyImportJob,
  applyImportStatus,
  useObsidianImportStore,
} from "../../state/obsidian-import-store";
import { toast } from "../../state/toast-store";
import { UpdateReport } from "./ImportReport";
import { formatDay, type ImportProblem, importProblem, PAIRED_DEVICE_REASON } from "./import-text";
import { ObsidianImportFlow, ProgressBar } from "./ObsidianImportFlow";
import "../../styles/vault.css";

function CopyPath({ path, label }: { path: string; label: string }) {
  return (
    <IconButton
      icon={Copy}
      label={label}
      onClick={() => {
        void copyText(path).then((ok) => ok && toast({ kind: "success", title: "Path copied" }));
      }}
    />
  );
}

/** Settings → Vault: the vault this daemon serves, its Obsidian origin, and importing one. */
export function VaultSection({ onOpenSync }: { onOpenSync?: () => void }) {
  const { client } = useServices();
  const [vault, setVault] = useState<DeviceVaultResponse | null>(null);
  const [sync, setSync] = useState<SyncStatusResponse | null>(null);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const imported = useObsidianImportStore((s) => s.imported);
  const connection = useConnectionStore((s) => s.state);
  const forbidden = problem?.code === "forbidden_device";

  const refresh = useCallback(async () => {
    const [vaultResult, statusResult, syncResult] = await Promise.allSettled([
      client.getVault(),
      client.getObsidianImport(),
      client.getSyncStatus(),
    ]);
    if (vaultResult.status === "fulfilled") setVault(vaultResult.value);
    if (statusResult.status === "fulfilled") applyImportStatus(statusResult.value);
    if (syncResult.status === "fulfilled") setSync(syncResult.value);
    const failed = [vaultResult, statusResult].find((r) => r.status === "rejected");
    setProblem(failed ? importProblem(failed.reason) : null);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Back after a drop: jobs may have moved on without us hearing.
  const wasOnline = useRef(connection === "online");
  useEffect(() => {
    if (connection === "online" && !wasOnline.current) void refresh();
    wasOnline.current = connection === "online";
  }, [connection, refresh]);

  // A finished update changes where the vault stands (its last update).
  const job = useObsidianImportStore((s) => s.job);
  const finished = job && job.state !== "running" ? job.id : null;
  useEffect(() => {
    if (finished) void refresh();
  }, [finished, refresh]);

  const disabledReason = forbidden ? PAIRED_DEVICE_REASON : null;
  return (
    <section data-testid="settings-vault">
      <h2 className="settings-heading">Vault</h2>
      {forbidden ? (
        <div className="settings-problem" data-testid="vault-forbidden">
          {PAIRED_DEVICE_REASON}
        </div>
      ) : problem ? (
        <div className="settings-problem" data-testid="vault-problem">
          {problem.message}
        </div>
      ) : null}
      {vault ? (
        <div className="setting" data-testid="vault-current">
          <div className="setting-info">
            <div className="setting-name">This vault</div>
            <div className="setting-description vault-path">
              <code>{vault.path}</code>
              {vault.lockedByEnv ? " · set by DDL_VAULT" : null}
            </div>
          </div>
          <div className="setting-control">
            <CopyPath path={vault.path} label="Copy the vault's path" />
          </div>
        </div>
      ) : null}
      {imported ? <ImportedFrom imported={imported} disabledReason={disabledReason} /> : null}
      <h3 className="settings-subheading">Import from Obsidian</h3>
      <p className="settings-hint">
        Makes a new vault from your Obsidian vault, with your Daily Do List notes, routines and
        agent history carried over. You see what will happen before anything is copied.
      </p>
      <ObsidianImportFlow
        vault={vault}
        sync={sync}
        disabledReason={disabledReason}
        refresh={() => void refresh()}
        {...(onOpenSync ? { onOpenSync } : {})}
      />
    </section>
  );
}

/** Where this vault came from, "Update from Obsidian", and the backup. */
function ImportedFrom({
  imported,
  disabledReason,
}: {
  imported: ObsidianImportOrigin;
  disabledReason: string | null;
}) {
  const { client } = useServices();
  const job = useObsidianImportStore((s) => s.job);
  const [busy, setBusy] = useState<"update" | "cancel" | null>(null);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const update = job?.kind === "update" ? job : null;
  const running = job?.state === "running";

  const run = async (action: "update" | "cancel") => {
    setBusy(action);
    setProblem(null);
    try {
      const response =
        action === "update"
          ? await client.updateFromObsidian()
          : await client.cancelObsidianImport();
      applyImportJob(response.job);
    } catch (error) {
      setProblem(importProblem(error));
      applyImportStatus(await client.getObsidianImport().catch(() => ({ job, imported })));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="setting" data-testid="vault-imported">
        <div className="setting-info">
          <div className="setting-name">Imported from Obsidian</div>
          <div className="setting-description vault-path">
            From <code>{imported.source}</code> on {formatDay(imported.importedAt)}
            {imported.updatedAt ? `; last updated ${formatDay(imported.updatedAt)}` : null}.
          </div>
        </div>
        <div className="setting-control">
          <DisabledReason
            reason={disabledReason ?? (running ? "An import or update is running" : null)}
          >
            <button
              type="button"
              className="button"
              onClick={() => void run("update")}
              disabled={Boolean(disabledReason) || running || busy !== null}
              data-testid="vault-update"
            >
              {busy === "update" ? "Starting…" : "Update from Obsidian"}
            </button>
          </DisabledReason>
        </div>
      </div>
      <p className="settings-hint vault-update-hint">
        Still writing in Obsidian, or on your phone with Obsidian Sync? This copies what changed
        there since the import. It never deletes anything, and keeps both versions of a note changed
        in both places. Tasks it brings in are new to the agent: it picks them up as if you had just
        written them.
      </p>
      {update ? (
        <div className="vault-update" data-testid="vault-update-job">
          {update.state === "running" ? (
            <>
              <ProgressBar job={update} />
              <button
                type="button"
                className="button"
                onClick={() => void run("cancel")}
                disabled={busy !== null}
                data-tooltip="Stop; files already copied stay"
                data-testid="vault-update-cancel"
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            </>
          ) : null}
          {update.state === "done" && update.update ? (
            <UpdateReport update={update.update} />
          ) : null}
          {update.state === "failed" ? (
            <div className="settings-problem">The update stopped: {update.error}.</div>
          ) : null}
          {update.state === "cancelled" ? (
            <p className="report-line muted">
              The update was cancelled; the files it had copied stay.
            </p>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <div className="settings-problem" role="alert" data-testid="vault-update-problem">
          {problem.message}
        </div>
      ) : null}
      {imported.previousVault ? (
        <div className="setting" data-testid="vault-previous">
          <div className="setting-info">
            <div className="setting-name">Previous vault</div>
            <div className="setting-description vault-path">
              <code>{imported.previousVault}</code>, kept untouched: it&apos;s your backup.
            </div>
          </div>
          <div className="setting-control">
            <CopyPath path={imported.previousVault} label="Copy the previous vault's path" />
          </div>
        </div>
      ) : null}
    </>
  );
}

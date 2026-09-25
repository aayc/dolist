import type { DaemonRestart } from "@ddl/core";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectionState } from "../../api/client";
import { useServices } from "../../app/services";
import { useConnectionStore } from "../../state/connection-store";
import { Modal } from "../overlays/Modal";
import { vaultName, waitForVault } from "./vault-switch";
import "../../styles/vault.css";

/** A restart the app's supervisor does takes seconds; after this long, say what to check. */
const SLOW_MS = 30_000;

const STATE_TEXT: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  online: "Waiting for Daily Do List to restart…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

function reloadPage(): void {
  location.reload();
}

/**
 * Covers the app while the daemon restarts on another vault, and reloads the page once it answers
 * there. It can't be closed: the old vault's notes must not be edited meanwhile.
 */
export function VaultSwitchOverlay({
  path,
  restart,
  onBack = reloadPage,
}: {
  path: string;
  restart: DaemonRestart;
  onBack?: () => void;
}) {
  const { client } = useServices();
  const connection = useConnectionStore((s) => s.state);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    void waitForVault(client, path, { signal: controller.signal }).then((back) => {
      if (back) onBack();
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, path, onBack]);
  const manual = restart === "manual";
  return (
    <Modal label="Switching vaults" className="vault-switch-modal" testId="vault-switch">
      <div className="vault-switch" aria-live="polite">
        <LoaderCircle size={22} className="spin vault-switch-spinner" aria-hidden="true" />
        <h2 className="vault-switch-title">Switching to {vaultName(path)}</h2>
        {manual ? (
          <p>
            The daemon stopped so it can open the new vault. Start it again the way you started it
            (for example <code>pnpm start</code>): this page reconnects when it&apos;s back.
          </p>
        ) : (
          <p>
            Daily Do List is restarting on the new vault. This page reconnects by itself when
            it&apos;s back.
          </p>
        )}
        <p className="vault-switch-path">
          <code>{path}</code>
        </p>
        <p className="muted" data-testid="vault-switch-state">
          {STATE_TEXT[connection]}
        </p>
        {slow && !manual ? (
          <div className="settings-problem" data-testid="vault-switch-slow">
            This is taking longer than usual. The daemon&apos;s log says why (in the Mac app:
            Settings → General → Daemon log).{" "}
            <button type="button" className="link-button" onClick={() => location.reload()}>
              Reload the page
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

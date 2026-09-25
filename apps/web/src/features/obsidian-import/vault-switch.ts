import type { DeviceVaultResponse } from "@ddl/core";
import type { DaemonClient } from "../../api/client";
import { toast } from "../../state/toast-store";
import { ui } from "../../state/ui-store";

/** Survives the reload after a switch (this tab only), so the page can say where it is now. */
const NOTICE_KEY = "ddl-vault-switched";

interface SwitchNotice {
  path: string;
  /** The vault switched away from: kept untouched. */
  previous: string | null;
}

export interface SwitchDeps {
  client: Pick<DaemonClient, "switchVault">;
  /** Saves every open note (to the vault being left). */
  flush(): Promise<void>;
  /** Loads the switching overlay's code while the daemon still serves it. */
  preload(): Promise<unknown>;
}

export function vaultName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/**
 * Saves open notes, then asks the daemon to open `path`. When it restarts to do so, the switching
 * overlay covers the app until it's back, and the page then reloads on the new vault: nothing of
 * the old vault (open notes, the agent's threads) is left to write into the new one.
 */
export async function requestVaultSwitch(
  deps: SwitchDeps,
  path: string,
  previous: string | null,
): Promise<DeviceVaultResponse> {
  await deps.preload();
  await deps.flush();
  const response = await deps.client.switchVault(path);
  if (response.restart) {
    remember({ path: response.path, previous });
    ui.openOverlay({ kind: "vault-switch", path: response.path, restart: response.restart });
  }
  return response;
}

/**
 * Resolves true once the daemon answers on `path` (the old one keeps answering with its own vault
 * until it exits), false when aborted.
 */
export async function waitForVault(
  client: Pick<DaemonClient, "getVault">,
  path: string,
  options: { signal: AbortSignal; intervalMs?: number },
): Promise<boolean> {
  const { signal, intervalMs = 500 } = options;
  while (!signal.aborted) {
    try {
      if ((await client.getVault()).path === path) return !signal.aborted;
    } catch {
      // Away while it restarts.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  return false;
}

function remember(notice: SwitchNotice): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, JSON.stringify(notice));
  } catch {
    // Only the notice after the reload is lost.
  }
}

/** After the reload that follows a switch: says which vault this is, and where the old one is. */
export function announceVaultSwitch(): void {
  let notice: SwitchNotice | null = null;
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    notice = raw ? (JSON.parse(raw) as SwitchNotice) : null;
  } catch {
    return;
  }
  if (!notice || typeof notice.path !== "string") return;
  toast({
    kind: "success",
    title: `Now on ${vaultName(notice.path)}`,
    ...(typeof notice.previous === "string"
      ? { body: `Your previous vault is kept untouched at ${notice.previous}.` }
      : {}),
    timeoutMs: 12_000,
  });
}

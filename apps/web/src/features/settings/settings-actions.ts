import type { AppSettings, DeepPartial } from "@ddl/core";
import type { DaemonClient } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { applySettings, patchSettingsLocally } from "../../state/settings-store";
import { toast } from "../../state/toast-store";

/** Optimistic settings update: applied immediately, then confirmed (or corrected) by the daemon. */
export async function updateSettings(
  client: DaemonClient,
  patch: DeepPartial<AppSettings>,
): Promise<void> {
  patchSettingsLocally(patch);
  try {
    const response = await client.updateSettings(patch);
    applySettings(response.settings);
  } catch (error) {
    toast({ kind: "error", title: "Couldn't save settings", body: errorMessage(error) });
    try {
      applySettings((await client.getSettings()).settings);
    } catch {
      // Keep the optimistic value; the next settings.changed event will correct it.
    }
  }
}

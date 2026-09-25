import type { ObsidianImportJob } from "@ddl/core";
import { toast } from "../state/toast-store";
import { ui } from "../state/ui-store";

function vaultOnScreen(): boolean {
  const { overlay } = ui.get();
  return overlay?.kind === "settings" && overlay.section === "vault";
}

const TITLES: Partial<Record<ObsidianImportJob["state"], [string, string]>> = {
  done: ["Import from Obsidian finished", "Update from Obsidian finished"],
  failed: ["Import from Obsidian stopped", "Update from Obsidian stopped"],
};

/**
 * An import or update that ended while Settings → Vault wasn't showing: says so, and opens it
 * (the switch to the new vault is there).
 */
export function announceImportEnd(job: ObsidianImportJob): void {
  const titles = TITLES[job.state];
  if (!titles || vaultOnScreen()) return;
  toast({
    id: `import-${job.id}`,
    kind: job.state === "done" ? "success" : "error",
    title: job.kind === "import" ? titles[0] : titles[1],
    ...(job.state === "failed" && job.error ? { body: job.error } : {}),
    actionLabel: "Open",
    timeoutMs: 10_000,
    onClick: () => ui.openOverlay({ kind: "settings", section: "vault" }),
  });
}

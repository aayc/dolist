import { PERSISTED_APPROVALS_VERSION } from "./approvals";
import { PERSISTED_IMPORT_MANIFEST_VERSION } from "./import-manifest";
import { PERSISTED_PATHS } from "./primitives";
import { PERSISTED_RECORDS_VERSION } from "./records";
import { PERSISTED_ROUTINES_VERSION } from "./routines";
import { PERSISTED_SETTINGS_VERSION } from "./settings";
import { PERSISTED_TASK_STATE_VERSION } from "./task-state";
import { PERSISTED_THREAD_VERSION } from "./thread";

export type PersistedFormatName =
  | "thread"
  | "artifact-body"
  | "task-state"
  | "records"
  | "approvals"
  | "routines"
  | "settings"
  | "import-manifest";

export interface PersistedFormatInfo {
  name: PersistedFormatName;
  /** Vault path, with `<placeholders>`. */
  path: string;
  /** Current format version; `null` for non-JSON bodies. */
  version: number | null;
  /** Module that owns reading and writing it. */
  owner: string;
  /** Replicated by the SyncEngine (a vault inside a synced folder carries everything). */
  syncs: boolean;
}

/** Every file in the vault sidecar this app reads and writes (docs/DATA_FORMATS.md). */
export const PERSISTED_FORMATS: readonly PersistedFormatInfo[] = [
  {
    name: "thread",
    path: `${PERSISTED_PATHS.threads}/<threadId>.json`,
    version: PERSISTED_THREAD_VERSION,
    owner: "packages/agent/src/threads/store.ts",
    syncs: true,
  },
  {
    name: "artifact-body",
    path: `${PERSISTED_PATHS.artifacts}/<threadId>/<artifactId>.<ext>[.b64]`,
    version: null,
    owner: "packages/agent/src/threads/store.ts",
    syncs: true,
  },
  {
    name: "task-state",
    path: `${PERSISTED_PATHS.taskState}/<hash(notePath)>.json`,
    version: PERSISTED_TASK_STATE_VERSION,
    owner: "packages/agent/src/orchestrator/task-watcher.ts",
    syncs: false,
  },
  {
    name: "records",
    path: PERSISTED_PATHS.records,
    version: PERSISTED_RECORDS_VERSION,
    owner: "packages/agent/src/orchestrator/records.ts",
    syncs: true,
  },
  {
    name: "approvals",
    path: PERSISTED_PATHS.approvals,
    version: PERSISTED_APPROVALS_VERSION,
    owner: "packages/agent/src/safety/approval-store.ts",
    syncs: true,
  },
  {
    name: "routines",
    path: PERSISTED_PATHS.routines,
    version: PERSISTED_ROUTINES_VERSION,
    owner: "packages/agent/src/routines/state.ts",
    syncs: true,
  },
  {
    name: "settings",
    path: PERSISTED_PATHS.settings,
    version: PERSISTED_SETTINGS_VERSION,
    owner: "apps/daemon/src/settings-store.ts",
    syncs: true,
  },
  {
    name: "import-manifest",
    path: PERSISTED_PATHS.importManifest,
    version: PERSISTED_IMPORT_MANIFEST_VERSION,
    owner: "apps/daemon/src/import/manifest.ts",
    syncs: false,
  },
];

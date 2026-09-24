import { type ThemePreference, today, toISODate } from "@ddl/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDaemonClient, isMockMode } from "../api/select-client";
import { installGlobalHotkeys } from "../commands/keyboard";
import {
  applyEditorCssVars,
  applyTheme,
  editorConfigFrom,
  storedThemePreference,
} from "../features/settings/theme";
import { onIdle } from "../lib/idle";
import { installPerfGlobal, perfDetailed } from "../perf/perf";
import { useConnectionStore } from "../state/connection-store";
import { applySettings, getSettings, useSettingsStore } from "../state/settings-store";
import { App } from "./App";
import { installApprovalToastCleanup } from "./approval-toasts";
import { prefetchLazyChunks } from "./lazy";
import { handleServerEvent } from "./server-events";
import { createServices, type Services, ServicesContext } from "./services";

export interface DebugHooks {
  evictNote(path: string): void;
  activePath(): string | null;
  openNote(path: string, newTab?: boolean): Promise<boolean>;
  /** Sanitizer check in a real browser (DOMPurify needs a full DOM). Loads the lazy chunk. */
  renderMarkdown(source: string): Promise<string>;
  /** Holds every note write for `ms` before sending it (0 restores), to test saves in flight. */
  delayWrites(ms: number): void;
  runCommand(id: string): boolean;
}

declare global {
  interface Window {
    __ddlDebug?: DebugHooks;
  }
}

/** Startup requests run in parallel; today's note is shown as soon as it arrives. */
async function loadInitialData(services: Services): Promise<boolean> {
  const { client, workspace, agent } = services;
  const daily = client.getDailyNote(toISODate(today()), true);
  const tree = client.getTree();
  const settings = client.getSettings();
  const health = client.health();
  const overview = agent.loadOverview();

  let ok = true;
  try {
    await workspace.showStartupNote(await daily);
  } catch {
    ok = false;
  }
  const [treeResult, settingsResult, healthResult] = await Promise.allSettled([
    tree,
    settings,
    health,
  ]);
  if (treeResult.status === "fulfilled") workspace.applyTree(treeResult.value);
  else ok = false;
  if (settingsResult.status === "fulfilled") applySettings(settingsResult.value.settings);
  if (healthResult.status === "fulfilled")
    useConnectionStore.setState({ health: healthResult.value });
  await overview;
  useConnectionStore.setState({ unreachable: !ok });
  return ok;
}

async function resync(services: Services): Promise<void> {
  try {
    applySettings((await services.client.getSettings()).settings);
  } catch {
    // The next reconnect retries.
  }
  await Promise.allSettled([services.workspace.resync(), services.agent.resync()]);
}

function installSettingsEffects(services: Services, appliedTheme: ThemePreference): void {
  let theme = appliedTheme;
  let editor = getSettings().editor;
  useSettingsStore.subscribe(({ settings }) => {
    if (settings.theme !== theme) {
      theme = settings.theme;
      applyTheme(theme);
    }
    if (settings.editor !== editor) {
      editor = settings.editor;
      services.workspace.editor.configure(editorConfigFrom(settings));
      applyEditorCssVars(settings);
    }
  });
}

function installDebugHooks(services: Services): void {
  if (!isMockMode() && !perfDetailed) return;
  const { client } = services;
  const writeNote = client.writeNote.bind(client);
  window.__ddlDebug = {
    evictNote: (path) => services.workspace.evict(path),
    activePath: () => services.workspace.activePath,
    openNote: (path, newTab) => services.workspace.openNote(path, { newTab: newTab ?? false }),
    renderMarkdown: async (source) => (await import("../lib/markdown")).renderMarkdown(source),
    delayWrites: (ms) => {
      client.writeNote =
        ms > 0
          ? (...args) =>
              new Promise((resolve) => setTimeout(resolve, ms)).then(() => writeNote(...args))
          : writeNote;
    },
    runCommand: (id) => services.commands.run(id),
  };
}

export async function startApp(container: HTMLElement): Promise<void> {
  const perf = installPerfGlobal();
  const settings = getSettings();
  // Keep the boot script's choice; the daemon's settings (authoritative) arrive moments later.
  const theme = storedThemePreference() ?? settings.theme;
  applyTheme(theme);
  applyEditorCssVars(settings);

  const client = await createDaemonClient();
  const services = createServices(client);

  let initialLoaded = false;
  let loading: Promise<void> | null = null;
  const load = () => {
    loading ??= loadInitialData(services)
      .then((ok) => {
        initialLoaded = ok;
        if (ok) {
          onIdle(() => {
            void prefetchLazyChunks().then(() => {
              perf.prefetched = true;
            });
          });
        }
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  useConnectionStore.setState({
    kind: client.kind,
    endpoint: client.endpoint,
    state: client.connectionState,
  });
  client.onConnectionChange(({ state, reconnected }) => {
    useConnectionStore.setState({ state });
    if (state !== "online") return;
    if (!initialLoaded) void load();
    else if (reconnected) void resync(services);
  });
  client.onEvent((event) => handleServerEvent(event, services));
  client.connect();

  installGlobalHotkeys(services.commands);
  installApprovalToastCleanup();
  services.workspace.installLifecycle();
  installSettingsEffects(services, theme);
  installDebugHooks(services);

  createRoot(container).render(
    <StrictMode>
      <ServicesContext value={services}>
        <App />
      </ServicesContext>
    </StrictMode>,
  );
  await load();
}

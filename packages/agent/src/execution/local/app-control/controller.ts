import { type ComputerHostApp, type Logger, silentLogger } from "@ddl/core";
import { ComputerPermissionError, ProtectedAppError, StaleElementError } from "../../errors";
import type {
  AppActionOutcome,
  AppController,
  AppElementTarget,
  AppScreenshot,
  AppSnapshot,
  ComputerPermissions,
  InstalledApp,
  PressAction,
  ResolvedApp,
  RunningApp,
} from "../../types";
import { permissionHelp, permissionsNamedIn } from "../computer-permissions";
import type { CallOptions, HelperClient } from "./client";
import {
  HelperError,
  type HelperMethod,
  parseInstalledApps,
  parseOutcome,
  parsePermissions,
  parseResolvedApp,
  parseRunningApps,
  parseScreenshot,
  parseSetValue,
  parseSnapshot,
} from "./protocol";

const INSTALLED_APPS_TTL_MS = 10 * 60_000;
/** The helper waits up to 10 s for a launched app to be running. */
const OPEN_APP_TIMEOUT_MS = 25_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;

export interface HelperAppControllerOptions {
  client: HelperClient;
  /** The app the permissions belong to, for permission help. */
  hostApp?: () => Promise<ComputerHostApp | undefined>;
  logger?: Logger;
  now?: () => number;
}

/** {@link AppController} over the `ddl-computer` helper. */
export class HelperAppController implements AppController {
  private readonly client: HelperClient;
  private readonly hostApp: () => Promise<ComputerHostApp | undefined>;
  private readonly logger: Logger;
  private readonly now: () => number;
  private installed: { apps: InstalledApp[]; at: number } | undefined;
  private installedLoad: Promise<InstalledApp[]> | undefined;

  constructor(options: HelperAppControllerOptions) {
    this.client = options.client;
    this.hostApp = options.hostApp ?? (async () => undefined);
    this.logger = (options.logger ?? silentLogger).child({ component: "app-control" });
    this.now = options.now ?? Date.now;
  }

  get available(): boolean {
    return this.client.available;
  }

  async permissions(): Promise<ComputerPermissions> {
    return parsePermissions(await this.call("permissions", {}));
  }

  async runningApps(): Promise<RunningApp[]> {
    return parseRunningApps(await this.call("apps", {}));
  }

  installedApps(): Promise<InstalledApp[]> {
    const cached = this.installed;
    if (cached && this.now() - cached.at < INSTALLED_APPS_TTL_MS) {
      return Promise.resolve(cached.apps);
    }
    this.installedLoad ??= this.call("installedApps", {}, { timeoutMs: SNAPSHOT_TIMEOUT_MS })
      .then((result) => {
        const apps = parseInstalledApps(result);
        this.installed = { apps, at: this.now() };
        return apps;
      })
      .finally(() => {
        this.installedLoad = undefined;
      });
    return this.installedLoad;
  }

  async openApp(target: { name: string } | { bundleId: string }): Promise<ResolvedApp> {
    return parseResolvedApp(
      await this.call("resolveApp", target, { timeoutMs: OPEN_APP_TIMEOUT_MS }),
    );
  }

  async snapshot(
    pid: number,
    options: { expand?: AppElementTarget; maxNodes?: number } = {},
  ): Promise<AppSnapshot> {
    const params = {
      pid,
      ...(options.expand
        ? { elementId: options.expand.elementId, snapshotId: options.expand.snapshotId }
        : {}),
      ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    };
    return parseSnapshot(await this.call("snapshot", params, { timeoutMs: SNAPSHOT_TIMEOUT_MS }));
  }

  async screenshot(pid?: number, options: { maxWidth?: number } = {}): Promise<AppScreenshot> {
    const params = {
      ...(pid === undefined ? {} : { pid }),
      ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
    };
    return parseScreenshot(
      await this.call("screenshot", params, { timeoutMs: SCREENSHOT_TIMEOUT_MS }),
    );
  }

  async press(
    pid: number,
    target: AppElementTarget,
    action: PressAction = "press",
  ): Promise<AppActionOutcome> {
    return parseOutcome(await this.call("press", { pid, ...target, action }));
  }

  async setValue(
    pid: number,
    target: AppElementTarget,
    value: string,
  ): Promise<AppActionOutcome & { value?: string }> {
    return parseSetValue(await this.call("setValue", { pid, ...target, value }));
  }

  async typeText(pid: number, text: string, target?: AppElementTarget): Promise<AppActionOutcome> {
    return parseOutcome(
      await this.call(
        "typeText",
        { pid, text, ...(target ?? {}) },
        { timeoutMs: 15_000 + text.length * 20 },
      ),
    );
  }

  async key(pid: number, combo: string): Promise<AppActionOutcome> {
    return parseOutcome(await this.call("key", { pid, combo }));
  }

  async click(
    pid: number,
    point: { x: number; y: number },
    options: { button?: "left" | "right"; count?: number } = {},
  ): Promise<AppActionOutcome> {
    return parseOutcome(await this.call("click", { pid, ...point, ...options }));
  }

  async scroll(pid: number, point: { x: number; y: number }, dx: number, dy: number) {
    await this.call("scroll", { pid, ...point, dx, dy });
  }

  dispose(): Promise<void> {
    return this.client.dispose();
  }

  private async call(method: HelperMethod, params: object, options?: CallOptions) {
    try {
      return await this.client.call(method, params, options);
    } catch (error) {
      throw await this.mapError(error);
    }
  }

  private async mapError(error: unknown): Promise<unknown> {
    if (!(error instanceof HelperError)) return error;
    switch (error.code) {
      case "permission": {
        const host = await this.hostApp().catch(() => undefined);
        this.logger.debug("computer helper lacks a permission", { method: error.method });
        return new ComputerPermissionError(
          permissionHelp(permissionsNamedIn(error.message), host?.name),
          { cause: error },
        );
      }
      case "protected":
        return new ProtectedAppError(
          `${error.message} This app is off-limits to agents: don't try to reach it another way (other tools, the screen or the keyboard). Tell the user what you needed from it instead.`,
          { cause: error },
        );
      case "stale":
        return new StaleElementError(
          `${error.message} The app changed since it was read: call computer_app_state again and use the new element ids.`,
          { cause: error },
        );
      default:
        return error;
    }
  }
}

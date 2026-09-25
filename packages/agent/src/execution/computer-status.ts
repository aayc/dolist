import { type ComputerAccess, type Logger, silentLogger } from "@ddl/core";
import { protectedApp } from "../safety/apps";
import type { ExecutionProvider } from "./types";

export interface ComputerStatus {
  /** The latest permission and app control status; undefined until known, or without computer use. */
  access?: ComputerAccess;
  /** Apps agents could operate, running ones first (never protected ones), capped. */
  apps: string[];
  /** Apps left out of `apps` by the cap. */
  moreApps: number;
}

export interface ComputerStatusOptions {
  /** Permission status older than this is refreshed on the next read. Default 3 s. */
  accessTtlMs?: number;
  /** The app list older than this is refreshed on the next read. Default 60 s. */
  appsTtlMs?: number;
  /** Most app names kept. Default 80. */
  maxApps?: number;
  /** A refresh changed the status. */
  onChange?: () => void;
  now?: () => number;
  logger?: Logger;
}

/**
 * Caches what the agent runtime reports about computer use: the permission status (for the agent
 * status the UI shows) and the desktop apps (for the orchestrator's digest). Reads never wait: a
 * stale value starts a background refresh, and `onChange` fires when it brings something new.
 */
export class ComputerStatusMonitor {
  private readonly provider: ExecutionProvider;
  private readonly options: ComputerStatusOptions;
  private readonly now: () => number;
  private readonly logger: Logger;
  private status: ComputerStatus = { apps: [], moreApps: 0 };
  private accessAt = Number.NEGATIVE_INFINITY;
  private appsAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | undefined;
  private stopped = false;

  constructor(provider: ExecutionProvider, options: ComputerStatusOptions = {}) {
    this.provider = provider;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  /** Whether computer use exists here at all (so a status can ever be known). */
  get supported(): boolean {
    return this.provider.capabilities.computer && this.provider.computerAccess !== undefined;
  }

  current(): ComputerStatus {
    if (this.supported && !this.stopped && this.stale()) void this.refresh();
    return this.status;
  }

  /** Refreshes what is stale (or everything with `force`); one refresh at a time. */
  refresh(force = false): Promise<void> {
    if (!this.supported || this.stopped) return Promise.resolve();
    this.refreshing ??= this.load(force).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  stop(): void {
    this.stopped = true;
  }

  private stale(): boolean {
    const now = this.now();
    return (
      now - this.accessAt >= (this.options.accessTtlMs ?? 3_000) ||
      (this.provider.apps !== undefined && now - this.appsAt >= (this.options.appsTtlMs ?? 60_000))
    );
  }

  private async load(force: boolean): Promise<void> {
    const now = this.now();
    const next: ComputerStatus = { ...this.status };
    if (force || now - this.accessAt >= (this.options.accessTtlMs ?? 3_000)) {
      try {
        const access = await this.provider.computerAccess?.();
        if (access) next.access = access;
        else delete next.access;
      } catch (error) {
        this.logger.debug("computer access check failed", { error: String(error) });
      }
      this.accessAt = this.now();
    }
    const apps = this.provider.apps;
    if (apps && (force || now - this.appsAt >= (this.options.appsTtlMs ?? 60_000))) {
      try {
        const [running, installed] = await Promise.all([apps.runningApps(), apps.installedApps()]);
        const names: string[] = [];
        const seen = new Set<string>();
        const add = (name: string, bundleId?: string) => {
          const key = name.toLowerCase();
          if (seen.has(key) || protectedApp(name, bundleId)) return;
          seen.add(key);
          names.push(name);
        };
        for (const app of running) add(app.name, app.bundleId);
        const byFolder = [...installed].sort(
          (a, b) =>
            Number(a.path.startsWith("/System/")) - Number(b.path.startsWith("/System/")) ||
            a.name.localeCompare(b.name),
        );
        for (const app of byFolder) add(app.name, app.bundleId);
        const max = this.options.maxApps ?? 80;
        next.apps = names.slice(0, max);
        next.moreApps = Math.max(0, names.length - max);
      } catch (error) {
        this.logger.debug("desktop app list unavailable", { error: String(error) });
      }
      this.appsAt = this.now();
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed && !this.stopped) this.options.onChange?.();
  }
}

import type { AppElement, AppRef, AppSnapshot, AppWindow, RunningApp } from "./types";

/**
 * What one thread knows about the apps it operates: the apps it resolved, the snapshots it read
 * and the geometry of its app screenshots.
 *
 * Element ids are renumbered per thread (`e1`, `e2`, … never reused), so an id names exactly one
 * element of one snapshot. Approval cards and safety rules read the element's real label through
 * its id, and the action is sent with that same snapshot: if the app was read again meanwhile, the
 * helper answers `stale` instead of acting on whatever element got the same number.
 */
export interface KnownApp {
  name: string;
  bundleId?: string;
  pid: number;
}

export interface SessionSnapshot {
  snapshotId: string;
  app: KnownApp;
  window: AppWindow | null;
  /** An action changed the UI after this snapshot: its ids must not be used anymore. */
  stale: boolean;
  /** Helper element id → thread element id. */
  readonly ids: Map<string, string>;
}

export interface SessionElement {
  /** The id the model uses. */
  id: string;
  /** The helper's element (its own `id` is only valid within `snapshot`). */
  element: AppElement;
  snapshot: SessionSnapshot;
}

export interface ShotGeometry {
  width: number;
  height: number;
  scale: number;
  origin: { x: number; y: number };
}

/** Snapshots remembered per app; ids of older ones are forgotten. */
const SNAPSHOTS_PER_APP = 3;
const MAX_APPS = 24;

/** `  Grok Bot.app ` → `grok bot`: how app names are compared (and grant targets written). */
export function normalizeAppName(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.app\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Looks like `com.example.app` rather than an app name. */
export function looksLikeBundleId(text: string): boolean {
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}$/.test(text.trim());
}

/**
 * The candidates `text` names: an exact name or bundle id, else the unique app whose name starts
 * with it, else the unique one containing it. Several matches at the first level that has any are
 * returned as they are (ambiguous).
 */
export function matchApps<T extends { name: string; bundleId?: string }>(
  text: string,
  apps: readonly T[],
): T[] {
  const query = normalizeAppName(text);
  if (!query) return [];
  const exact = apps.filter(
    (app) =>
      normalizeAppName(app.name) === query ||
      (app.bundleId !== undefined && app.bundleId.toLowerCase() === query),
  );
  if (exact.length > 0) return exact;
  const prefix = apps.filter((app) => normalizeAppName(app.name).startsWith(query));
  if (prefix.length > 0) return prefix;
  return apps.filter((app) => normalizeAppName(app.name).includes(query));
}

export class AppSession {
  private readonly apps = new Map<string, KnownApp>();
  private readonly aliases = new Map<string, string>();
  private readonly snapshots = new Map<number, SessionSnapshot[]>();
  private readonly elements = new Map<string, SessionElement>();
  private readonly shots = new Map<number, ShotGeometry>();
  private running: KnownApp[] = [];
  private nextElement = 1;

  /** Remembers a resolved app, and the model's words that named it. */
  rememberApp(app: AppRef, alias?: string): KnownApp {
    const known: KnownApp = {
      name: app.name,
      ...(app.bundleId ? { bundleId: app.bundleId } : {}),
      pid: app.pid,
    };
    const key = appKey(known);
    const previous = this.apps.get(key);
    if (previous && previous.pid !== known.pid) this.forgetPid(previous.pid);
    this.apps.delete(key);
    this.apps.set(key, known);
    if (alias && normalizeAppName(alias)) this.aliases.set(normalizeAppName(alias), key);
    while (this.apps.size > MAX_APPS) {
      const [oldest, app] = this.apps.entries().next().value!;
      this.apps.delete(oldest);
      this.forgetPid(app.pid);
    }
    return known;
  }

  /**
   * Takes in the apps running now: pids change when apps relaunch, apps that quit are forgotten,
   * and the list is used to name apps this thread hasn't resolved yet.
   */
  rememberRunning(running: readonly RunningApp[]): void {
    this.running = running.map(({ name, bundleId, pid }) => ({
      name,
      ...(bundleId ? { bundleId } : {}),
      pid,
    }));
    const alive = new Set(running.map((app) => app.pid));
    for (const [key, app] of [...this.apps]) {
      const now = running.find((candidate) => appKey(candidate) === key);
      if (now) this.rememberApp(now);
      else if (!alive.has(app.pid)) {
        this.apps.delete(key);
        this.forgetPid(app.pid);
      }
    }
  }

  /** The app `text` names among the apps this thread has seen, when that is unambiguous. */
  findApp(text: string): KnownApp | undefined {
    const query = normalizeAppName(text);
    const aliased = this.aliases.get(query);
    if (aliased && this.apps.has(aliased)) return this.apps.get(aliased);
    const known = matchApps(text, [...this.apps.values()]);
    if (known.length === 1) return known[0];
    if (known.length > 1) return undefined;
    const running = matchApps(text, this.running);
    return running.length === 1 ? running[0] : undefined;
  }

  /** Takes a snapshot in (or its expansion into `into`), returning its text with thread ids. */
  addSnapshot(
    snapshot: AppSnapshot,
    into?: SessionSnapshot,
  ): { text: string; entry: SessionSnapshot } {
    const app = this.rememberApp(snapshot.app);
    let entry = into;
    if (!entry || entry.snapshotId !== snapshot.snapshotId || entry.app.pid !== app.pid) {
      entry = {
        snapshotId: snapshot.snapshotId,
        app,
        window: snapshot.window,
        stale: false,
        ids: new Map(),
      };
      this.pushSnapshot(app.pid, entry);
    }
    const target = entry;
    const idFor = (helperId: string) => {
      let id = target.ids.get(helperId);
      if (!id) {
        id = `e${this.nextElement++}`;
        target.ids.set(helperId, id);
      }
      return id;
    };
    for (const element of snapshot.elements) {
      const id = idFor(element.id);
      this.elements.set(id, { id, element, snapshot: target });
    }
    const text = snapshot.text.replace(
      /^([ \t]*)\[([^\]\s]{1,40})\]/gm,
      (_, indent: string, helperId: string) => `${indent}[${idFor(helperId)}]`,
    );
    return { text, entry: target };
  }

  element(id: string): SessionElement | undefined {
    return this.elements.get(id.trim());
  }

  /** After an action that changed the UI: the app's snapshots must be read again. */
  markStale(pid: number): void {
    for (const snapshot of this.snapshots.get(pid) ?? []) snapshot.stale = true;
  }

  latestSnapshot(pid: number): SessionSnapshot | undefined {
    return this.snapshots.get(pid)?.at(-1);
  }

  rememberShot(pid: number, geometry: ShotGeometry): void {
    this.shots.set(pid, geometry);
  }

  shot(pid: number): ShotGeometry | undefined {
    return this.shots.get(pid);
  }

  private pushSnapshot(pid: number, entry: SessionSnapshot): void {
    const list = this.snapshots.get(pid) ?? [];
    list.push(entry);
    while (list.length > SNAPSHOTS_PER_APP) this.dropSnapshot(list.shift()!);
    this.snapshots.set(pid, list);
  }

  private dropSnapshot(snapshot: SessionSnapshot): void {
    for (const id of snapshot.ids.values()) this.elements.delete(id);
  }

  private forgetPid(pid: number): void {
    for (const snapshot of this.snapshots.get(pid) ?? []) this.dropSnapshot(snapshot);
    this.snapshots.delete(pid);
    this.shots.delete(pid);
  }
}

function appKey(app: { name: string; bundleId?: string }): string {
  return app.bundleId
    ? `bundle:${app.bundleId.toLowerCase()}`
    : `name:${normalizeAppName(app.name)}`;
}

import {
  Emitter,
  errorMessage,
  hashString,
  isRoutinePath,
  type Logger,
  parseRoutineFile,
  ROUTINES_FOLDER,
  type RoutineFile,
  routineIdForPath,
  routineNameFromPath,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageEvent, StorageProvider } from "@ddl/storage";

/** A routine file as the catalog last read it. */
export interface RoutineDefinition {
  id: string;
  path: string;
  name: string;
  file: RoutineFile;
  /** Hash of the content (spots an unchanged rewrite and a rename). */
  contentHash: string;
}

export interface RoutineCatalogOptions {
  storage: StorageProvider;
  logger?: Logger;
}

type CatalogEvents = { changed: undefined };

/**
 * The routine files of the vault (`Routines/*.md`), parsed, kept current as they change from the
 * app, Obsidian or sync. A file that can't be read or parsed is still listed, with its problems.
 */
export class RoutineCatalog {
  private readonly storage: StorageProvider;
  private readonly logger: Logger;
  private readonly definitions = new Map<string, RoutineDefinition>();
  private readonly emitter = new Emitter<CatalogEvents>();
  private readonly pending = new Map<string, Promise<void>>();
  private unwatch: Unsubscribe | null = null;

  constructor(options: RoutineCatalogOptions) {
    this.storage = options.storage;
    this.logger = options.logger ?? silentLogger;
  }

  /** Reads every routine file, then follows changes. */
  async start(): Promise<void> {
    this.unwatch ??= this.storage.watch((event) => this.onStorageEvent(event));
    let entries: Array<{ path: string }> = [];
    try {
      entries = await this.storage.list({ prefix: ROUTINES_FOLDER });
    } catch (error) {
      this.logger.warn("Failed to list routines", { error: errorMessage(error) });
    }
    await Promise.all(
      entries.filter((entry) => isRoutinePath(entry.path)).map((entry) => this.reload(entry.path)),
    );
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  list(): RoutineDefinition[] {
    return [...this.definitions.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    );
  }

  get(id: string): RoutineDefinition | undefined {
    return this.definitions.get(id);
  }

  /** By name, ignoring case (how the orchestrator names routines). */
  findByName(name: string): RoutineDefinition | undefined {
    const wanted = name.trim().replace(/\.md$/i, "").toLowerCase();
    return this.list().find((definition) => definition.name.toLowerCase() === wanted);
  }

  on(listener: () => void): Unsubscribe {
    return this.emitter.on("changed", listener);
  }

  /** Re-reads one routine file now (after the app wrote it), serialized per path. */
  reload(path: string): Promise<void> {
    const previous = this.pending.get(path) ?? Promise.resolve();
    const next = previous.then(() => this.read(path));
    this.pending.set(path, next);
    void next.finally(() => {
      if (this.pending.get(path) === next) this.pending.delete(path);
    });
    return next;
  }

  private onStorageEvent(event: StorageEvent): void {
    if (!isRoutinePath(event.path)) return;
    void this.reload(event.path);
  }

  private async read(path: string): Promise<void> {
    const id = routineIdForPath(path);
    let content: string | null = null;
    try {
      content = (await this.storage.read(path))?.content ?? null;
    } catch (error) {
      this.logger.warn("Failed to read a routine", { path, error: errorMessage(error) });
      return;
    }
    if (content === null) {
      if (this.definitions.delete(id)) this.emitter.emit("changed", undefined);
      return;
    }
    const contentHash = hashString(content);
    if (this.definitions.get(id)?.contentHash === contentHash) return;
    this.definitions.set(id, {
      id,
      path,
      name: routineNameFromPath(path),
      file: parseRoutineFile(content),
      contentHash,
    });
    this.emitter.emit("changed", undefined);
  }
}

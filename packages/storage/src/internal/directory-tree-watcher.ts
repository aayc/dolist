import { EventEmitter } from "node:events";
import { type FSWatcher, lstatSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";

export interface DirectoryTreeWatcherOptions {
  /** Directories (vault-relative) not to watch, nor anything below them. */
  skip?(path: string): boolean;
}

/**
 * A recursive watcher built from one non-recursive `fs.watch` per directory. Node's own recursive
 * mode on Linux watches every file's inode by path and never re-watches a path it knows, so once a
 * file is replaced by a rename (an atomic save) later in-place edits to it go unreported. A
 * directory's watch reports each entry by name, whatever its inode. Symlinks are not followed.
 *
 * `listener` gets paths relative to `root` (`/`-separated), or `null` when a name is unknown.
 * Directories that appear are watched as their events arrive; files created inside them before
 * that are reported through the directory's own event. The returned handle emits `error` when the
 * root can no longer be watched or the system runs out of watches.
 */
export function watchDirectoryTree(
  root: string,
  listener: (eventType: string, filename: string | null) => void,
  options: DirectoryTreeWatcherOptions = {},
): DirectoryTreeWatcher {
  const watcher = new DirectoryTreeWatcher(root, listener, options);
  watcher.start();
  return watcher;
}

export class DirectoryTreeWatcher extends EventEmitter {
  private readonly root: string;
  private readonly listener: (eventType: string, filename: string | null) => void;
  private readonly skip: (path: string) => boolean;
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;

  constructor(
    root: string,
    listener: (eventType: string, filename: string | null) => void,
    options: DirectoryTreeWatcherOptions,
  ) {
    super();
    this.root = root;
    this.listener = listener;
    this.skip = options.skip ?? (() => false);
  }

  /** Watches the root and every directory below it. Throws when the root can't be watched. */
  start(): void {
    this.add("");
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /** Directories currently watched (vault-relative, `""` = root). */
  get watchedDirectories(): string[] {
    return [...this.watchers.keys()].sort();
  }

  private add(dir: string): void {
    if (this.closed || this.watchers.has(dir) || (dir !== "" && this.skip(dir))) return;
    const abs = dir === "" ? this.root : join(this.root, dir);
    const watcher = watch(abs, { persistent: false, encoding: "utf8" }, (eventType, name) =>
      this.onEvent(dir, eventType, name),
    );
    watcher.on("error", (error: unknown) => this.onWatcherError(dir, error));
    this.watchers.set(dir, watcher);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) this.tryAdd(childPath(dir, entry.name));
    }
  }

  /** Adds a subdirectory that may vanish meanwhile; running out of watches fails the whole tree. */
  private tryAdd(dir: string): void {
    try {
      this.add(dir);
    } catch (error) {
      this.forget(dir);
      if (!isGone(error)) this.emit("error", error);
    }
  }

  private onEvent(dir: string, eventType: string, name: string | null): void {
    if (this.closed) return;
    if (!name) {
      this.listener(eventType, null);
      return;
    }
    const path = childPath(dir, name);
    this.listener(eventType, path);
    if (eventType === "rename") this.refresh(path);
  }

  /** A path appeared or disappeared: watch it if it is now a directory, else stop watching it. */
  private refresh(path: string): void {
    let isDirectory = false;
    try {
      isDirectory = lstatSync(join(this.root, path)).isDirectory();
    } catch {
      // Gone.
    }
    if (isDirectory) this.tryAdd(path);
    else this.forget(path);
  }

  private onWatcherError(dir: string, error: unknown): void {
    if (this.closed) return;
    if (dir === "" || !isGone(error)) {
      this.emit("error", error);
      return;
    }
    this.forget(dir);
    this.listener("rename", dir);
  }

  /** Stops watching `dir` and everything below it. */
  private forget(dir: string): void {
    const prefix = `${dir}/`;
    for (const [path, watcher] of this.watchers) {
      if (path === dir || path.startsWith(prefix)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
  }
}

function childPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EPERM" || code === "EACCES";
}

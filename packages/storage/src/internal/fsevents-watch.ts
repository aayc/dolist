import { EventEmitter } from "node:events";
import { type FSWatcher, watch } from "node:fs";

type WatchListener = (eventType: string, filename: string | null) => void;

/** Every watch opened here and not closed yet. */
const open = new Set<FsEventsWatch>();

/**
 * `fs.watch(root, { recursive: true })` on macOS. libuv serves every directory watch of a process
 * from one FSEvents stream and recreates it, starting from "now", whenever one opens or closes:
 * what changes meanwhile is reported to no watch. Closing a watch returns once the new stream
 * runs, but opening one doesn't, so this also opens and closes a second watch on `root` before
 * returning. Then, and after it closes, every other watch opened here emits `restart`: its events
 * may have been lost, and it is live again.
 */
export function watchWithFsEvents(root: string, listener: WatchListener): FsEventsWatch {
  return new FsEventsWatch(root, listener);
}

export class FsEventsWatch extends EventEmitter {
  private readonly watcher: FSWatcher;

  constructor(root: string, listener: WatchListener) {
    super();
    this.watcher = watch(root, { recursive: true, persistent: false, encoding: "utf8" }, listener);
    this.watcher.on("error", (error: unknown) => this.emit("error", error));
    try {
      watch(root, { persistent: false }).close();
    } catch (error) {
      this.watcher.close();
      restarted();
      throw error;
    }
    restarted();
    open.add(this);
  }

  close(): void {
    if (!open.delete(this)) return;
    this.watcher.close();
    restarted();
  }
}

function restarted(): void {
  for (const watch of [...open]) watch.emit("restart");
}

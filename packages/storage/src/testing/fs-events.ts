/**
 * Test helpers for file-system events. Tests only.
 *
 * On macOS, libuv serves every directory `fs.watch` of a process from one FSEvents stream, and
 * recreates it (starting from "now") whenever a watch is opened or closed. After an opening the new
 * stream comes up asynchronously, so a change made before it is live is never reported; on a busy
 * machine that takes a while. Before a test makes the change it asserts on, it proves events flow
 * by repeating a harmless change until its event arrives. `SimulatedFsEvents` lets a test lose a
 * change on purpose instead.
 */
import { EventEmitter } from "node:events";
import { isAbsolute, relative, sep } from "node:path";
import { sleep } from "@ddl/core";

export interface EventsFlowOptions {
  /** Gives up (and throws) after this long. A failure bound only. */
  timeoutMs?: number;
}

const FIRST_RETRY_MS = 100;
const MAX_RETRY_MS = 1_000;

/**
 * Calls `poke(attempt)` (a change whose event the test can see) until `arrived()` holds, waiting
 * longer between attempts each time.
 */
export async function untilEventsFlow(
  poke: (attempt: number) => Promise<void>,
  arrived: () => boolean,
  { timeoutMs = 20_000 }: EventsFlowOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let wait = FIRST_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    await poke(attempt);
    const retryAt = Math.min(Date.now() + wait, deadline);
    while (!arrived() && Date.now() < retryAt) await sleep(10);
    if (arrived()) return;
    if (Date.now() >= deadline) {
      throw new Error(`no file-system event arrived within ${timeoutMs} ms`);
    }
    wait = Math.min(wait * 2, MAX_RETRY_MS);
  }
}

type WatchListener = (eventType: string, filename: string | null) => void;

interface SimulatedWatch {
  path: string;
  recursive: boolean;
  listener: WatchListener | undefined;
}

/**
 * libuv's FSEvents stream, simulated so a test decides the interleaving: use `watch` as
 * `node:fs`'s. Every watch shares the stream, and `change` (a change on disk, absolute path)
 * reaches the watches above it a moment later. Opening or closing a watch recreates the stream,
 * losing changes not yet delivered. Closing returns once the new stream runs; after an opening,
 * changes are lost until `rebuilt()`, as when libuv's FSEvents thread is slow to get to it.
 */
export class SimulatedFsEvents {
  private readonly watches = new Set<SimulatedWatch>();
  private pending: string[] = [];
  private running = true;

  readonly watch = (
    path: string,
    options?: { recursive?: boolean } | WatchListener,
    listener?: WatchListener,
  ): EventEmitter & { close(): void } => {
    const watch: SimulatedWatch = {
      path,
      recursive: typeof options === "object" && options.recursive === true,
      listener: typeof options === "function" ? options : listener,
    };
    this.watches.add(watch);
    this.restart(false);
    return Object.assign(new EventEmitter(), {
      close: () => {
        if (this.watches.delete(watch)) this.restart(true);
      },
    });
  };

  change(path: string): void {
    if (!this.running) return;
    this.pending.push(path);
    setImmediate(() => this.deliver());
  }

  /** The stream recreated for the latest opening runs. */
  rebuilt(): void {
    this.running = true;
  }

  private restart(running: boolean): void {
    this.pending = [];
    this.running = running;
  }

  private deliver(): void {
    const paths = this.pending;
    this.pending = [];
    for (const path of paths) {
      for (const watch of this.watches) {
        const name = relative(watch.path, path);
        if (!name || name.startsWith("..") || isAbsolute(name)) continue;
        if (watch.recursive || !name.includes(sep)) watch.listener?.("rename", name);
      }
    }
  }
}

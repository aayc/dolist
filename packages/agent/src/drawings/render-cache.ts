/**
 * Rendered drawings on disk, keyed by a hash of what was rendered, in a machine-local folder
 * (`$DDL_HOME/cache/drawings`, never the vault). Bounded in bytes: the least recently used renders
 * go first; a file's modification time is its last use, so the order survives restarts.
 */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type Logger, silentLogger } from "@ddl/core";

export const RENDER_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface Entry {
  size: number;
  usedAt: number;
}

export interface RenderCacheOptions {
  dir: string;
  maxBytes?: number;
  logger?: Logger;
  now?: () => number;
}

export class RenderCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private index: Promise<Map<string, Entry>> | null = null;

  constructor(options: RenderCacheOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? RENDER_CACHE_MAX_BYTES;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<Buffer | null> {
    const entries = await this.entries();
    const entry = entries.get(key);
    if (!entry) return null;
    const file = this.fileFor(key);
    try {
      const data = await readFile(file);
      entry.usedAt = this.now();
      const at = new Date(entry.usedAt);
      await utimes(file, at, at).catch(() => {});
      return data;
    } catch {
      entries.delete(key);
      return null;
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    const entries = await this.entries();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(key);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
    entries.set(key, { size: data.length, usedAt: this.now() });
    await this.evict(entries);
  }

  private async evict(entries: Map<string, Entry>): Promise<void> {
    let total = 0;
    for (const entry of entries.values()) total += entry.size;
    if (total <= this.maxBytes) return;
    const oldest = [...entries].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, entry] of oldest) {
      if (total <= this.maxBytes) break;
      entries.delete(key);
      total -= entry.size;
      await unlink(this.fileFor(key)).catch(() => {});
    }
  }

  private entries(): Promise<Map<string, Entry>> {
    this.index ??= this.scan();
    return this.index;
  }

  private async scan(): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return entries;
    }
    await Promise.all(
      names.map(async (name) => {
        const match = /^([0-9a-f]{16,128})\.png$/.exec(name);
        if (!match) return;
        try {
          const info = await stat(join(this.dir, name));
          entries.set(match[1]!, { size: info.size, usedAt: info.mtimeMs });
        } catch {
          // Removed while we looked.
        }
      }),
    );
    this.logger.debug("render cache loaded", { renders: entries.size });
    return entries;
  }

  private fileFor(key: string): string {
    if (!/^[0-9a-f]{16,128}$/.test(key)) throw new Error("Render cache keys are hex hashes");
    return join(this.dir, `${key}.png`);
  }
}

import type { Logger } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";

export { readFixture } from "../../../contract/test/persisted/fixtures";

/** Fixed clock for quarantine names: 2026-09-23T12:00:00.000Z. */
export const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);
export const STAMP = "20260923T120000000Z";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | undefined;
}

/** A logger that records everything (and lets tests assert nothing sensitive was logged). */
export function recordingLogger(): Logger & { entries: LogEntry[]; text(): string } {
  const entries: LogEntry[] = [];
  const logger: Logger & { entries: LogEntry[]; text(): string } = {
    entries,
    debug: (message, fields) => entries.push({ level: "debug", message, fields }),
    info: (message, fields) => entries.push({ level: "info", message, fields }),
    warn: (message, fields) => entries.push({ level: "warn", message, fields }),
    error: (message, fields) => entries.push({ level: "error", message, fields }),
    child: () => logger,
    text: () => JSON.stringify(entries),
  };
  return logger;
}

export function vault(files: Record<string, string> = {}): MemoryStorageProvider {
  return new MemoryStorageProvider({ initialFiles: files, now: () => NOW });
}

/** Every sidecar file with its content, for exact assertions. */
export async function sidecar(storage: MemoryStorageProvider): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await storage.list({ prefix: ".daily-do-list", includeHidden: true })) {
    out[entry.path] = (await storage.read(entry.path))!.content;
  }
  return out;
}

export async function paths(storage: MemoryStorageProvider, prefix = ".daily-do-list") {
  return (await storage.list({ prefix, includeHidden: true })).map((entry) => entry.path);
}

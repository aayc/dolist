export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured single-line logger. Never pass secrets in `fields`. */
export function createConsoleLogger(
  level: LogLevel = "info",
  bindings: Record<string, unknown> = {},
): Logger {
  const min = LEVELS[level];
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const extra = { ...bindings, ...fields };
    const suffix = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}${suffix}`;
    if (lvl === "error" || lvl === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (more) => createConsoleLogger(level, { ...bindings, ...more }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export interface LogEntry {
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

/** For tests: keeps every entry; `text()` lets them assert nothing sensitive was logged. */
export function recordingLogger(): Logger & { entries: LogEntry[]; text(): string } {
  const entries: LogEntry[] = [];
  const record = (level: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, ...(fields ? { fields } : {}) });
  };
  const logger = {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
    text: () => JSON.stringify(entries),
  };
  return logger;
}

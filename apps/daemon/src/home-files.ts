/**
 * Writing the daemon's own files in `$DDL_HOME`: `config.json` edited in place (keys this code
 * doesn't own survive), `device.json`, and secrets (`sync-token`, `machine-token`) kept 0600.
 * Every write goes to a temporary file first and is renamed over the old one, so a crash never
 * leaves half a file. Writes to one path run one at a time.
 */
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const queues = new Map<string, Promise<unknown>>();

/** Runs `step` after every earlier step for the same path. */
function serialized<T>(path: string, step: () => Promise<T>): Promise<T> {
  const run = (queues.get(path) ?? Promise.resolve()).then(step);
  const settled = run.catch(() => undefined);
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return run;
}

/** Replaces `path` with `content` atomically, mode 0600. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Edits a JSON object file in place; `edit` mutates the parsed object. */
export interface JsonObjectFile {
  update(edit: (value: Record<string, unknown>) => void): Promise<void>;
}

export class InvalidJsonFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonFileError";
  }
}

/** A JSON object on disk (created when missing); anything but an object is refused. */
export function jsonObjectFile(path: string): JsonObjectFile {
  return {
    update: (edit) =>
      serialized(path, async () => {
        const value = await readJsonObject(path);
        edit(value);
        await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
      }),
  };
}

/** An in-memory JSON object file (tests). */
export function memoryJsonObjectFile(initial: Record<string, unknown> = {}): JsonObjectFile & {
  readonly value: Record<string, unknown>;
} {
  let value = structuredClone(initial);
  return {
    get value() {
      return value;
    },
    async update(edit) {
      const next = structuredClone(value);
      edit(next);
      value = next;
    },
  };
}

/** A one-line secret (a token) in its own 0600 file. It is never logged. */
export interface SecretFile {
  /** The trimmed content, or null when the file doesn't exist or is empty. */
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  /** Deletes the file (fine when it's already gone). */
  remove(): Promise<void>;
}

export function secretFile(path: string): SecretFile {
  return {
    read: () =>
      serialized(path, async () => {
        try {
          return (await readFile(path, "utf8")).trim() || null;
        } catch (error) {
          if (errnoCode(error) === "ENOENT") return null;
          throw error;
        }
      }),
    write: (value) => serialized(path, () => atomicWriteFile(path, `${value}\n`)),
    remove: () => serialized(path, () => rm(path, { force: true })),
  };
}

/** An in-memory secret file (tests). */
export function memorySecretFile(initial: string | null = null): SecretFile {
  let value = initial;
  return {
    read: async () => value,
    write: async (next) => {
      value = next.trim();
    },
    remove: async () => {
      value = null;
    },
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new InvalidJsonFileError(`${basename(path)} is not valid JSON; fix or remove it first`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidJsonFileError(`${basename(path)} must hold a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

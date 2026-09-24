/**
 * Model-based test: random command sequences run against MemoryStorageProvider (the reference
 * model) and LocalFsStorageProvider (a temp folder) must be indistinguishable: same values,
 * versions, sizes, error classes, self events and listings after every step.
 *
 * The path universe stays clear of what legitimately differs between the two: case-only and
 * Unicode-normalization variants (APFS folds them) and binary extensions (local-fs versions those
 * by stat). Those have dedicated tests in local-fs.edge.test.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPathError } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { MemoryStorageProvider } from "./memory";
import {
  ConflictError,
  type ListOptions,
  NotFoundError,
  StorageError,
  type StorageEvent,
  type StorageProvider,
  type WriteOptions,
} from "./types";

interface Model {
  memory: MemoryStorageProvider;
  events: StorageEvent[];
}

interface Real {
  local: LocalFsStorageProvider;
  events: StorageEvent[];
}

const FILES = [
  "a.md",
  "b.md",
  "Notes/a.md",
  "Notes/b.md",
  "Notes/Sub/c.md",
  "Other/d.txt",
  "Café/日記 🎉.md",
  "sp ace#%&?.md",
  ".hidden/h.md",
  "Notes/.secret.md",
  "node_modules/n.md",
  ".trash/t.md",
  "Notes/a.md~",
  ".DS_Store",
];
const FOLDERS = ["Notes", "Notes/Sub", "Other", "Empty", "Empty/Deeper", ".hidden", ".trash"];
const COLLISIONS = ["a.md/x.md", "Notes/a.md/y.md", "Other/d.txt/z.md"];
const ODD = [
  "",
  "/",
  "../x.md",
  "Notes/../../x.md",
  "./a.md",
  "Notes//b.md",
  "Notes\\a.md",
  "/b.md",
];

const pathArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...FILES) },
  { weight: 2, arbitrary: fc.constantFrom(...FOLDERS) },
  { weight: 1, arbitrary: fc.constantFrom(...COLLISIONS) },
  { weight: 1, arbitrary: fc.constantFrom(...ODD) },
);
const contentArb = fc.constantFrom(
  "",
  "one",
  "two\n",
  "- [ ] task\r\n- [x] done\r\n",
  "🎉 ümlaut 日本語",
  "\uFEFF# BOM",
  "lone \uD800 surrogate",
  "x".repeat(3000),
);
type IfMatch = "none" | "null" | "current" | "stale";
const ifMatchArb = fc.constantFrom<IfMatch>("none", "none", "null", "current", "stale");
const listOptionsArb: fc.Arbitrary<ListOptions> = fc.record(
  {
    prefix: fc.oneof(
      fc.constantFrom("", "Notes", "Notes/", "Notes/a.md", ".hidden", ".trash", "Nope", "../x"),
      pathArb,
    ),
    includeHidden: fc.boolean(),
  },
  { requiredKeys: [] },
);

type Outcome = { ok: unknown } | { error: string; currentVersion?: string | null };

function errorName(error: unknown): string {
  if (error instanceof ConflictError) return "ConflictError";
  if (error instanceof NotFoundError) return "NotFoundError";
  if (error instanceof InvalidPathError) return "InvalidPathError";
  if (error instanceof StorageError) return "StorageError";
  const code = (error as { code?: unknown })?.code;
  return `unexpected ${String(code ?? error)}`;
}

async function outcome<T>(op: () => Promise<T>, shape: (value: T) => unknown): Promise<Outcome> {
  try {
    return { ok: shape(await op()) };
  } catch (error) {
    return error instanceof ConflictError
      ? { error: errorName(error), currentVersion: error.currentVersion }
      : { error: errorName(error) };
  }
}

const withoutMtime = <T extends { mtime: number }>({ mtime: _mtime, ...rest }: T) => rest;
const selfEvents = (events: readonly StorageEvent[]) => events.filter((e) => e.self);

async function ifMatchFor(
  memory: MemoryStorageProvider,
  path: string,
  mode: IfMatch,
): Promise<WriteOptions> {
  switch (mode) {
    case "none":
      return {};
    case "null":
      return { ifMatch: null };
    case "stale":
      return { ifMatch: "stale-version" };
    case "current": {
      const current = await memory.stat(path).catch(() => null);
      return { ifMatch: current?.version ?? "missing-version" };
    }
  }
}

async function expectSameState(memory: StorageProvider, local: StorageProvider): Promise<void> {
  for (const includeHidden of [false, true]) {
    const [m, l] = await Promise.all([
      memory.list({ includeHidden }),
      local.list({ includeHidden }),
    ]);
    expect(l.map(withoutMtime), `list(includeHidden: ${includeHidden})`).toEqual(
      m.map(withoutMtime),
    );
    const [mf, lf] = await Promise.all([
      memory.listFolders({ includeHidden }),
      local.listFolders({ includeHidden }),
    ]);
    expect(lf, `listFolders(includeHidden: ${includeHidden})`).toEqual(mf);
  }
}

function command(
  label: string,
  run: (p: StorageProvider, memory: MemoryStorageProvider) => Promise<Outcome>,
): fc.AsyncCommand<Model, Real> {
  return {
    check: () => true,
    toString: () => label,
    async run(model, real) {
      model.events.length = 0;
      real.events.length = 0;
      const expected = await run(model.memory, model.memory);
      const actual = await run(real.local, model.memory);
      expect(actual, label).toEqual(expected);
      expect(selfEvents(real.events), `${label}: self events`).toEqual(selfEvents(model.events));
      await expectSameState(model.memory, real.local);
    },
  };
}

const commandsArb = fc.commands(
  [
    fc.tuple(pathArb, contentArb, ifMatchArb).map(([path, content, mode]) => {
      let options: WriteOptions | undefined;
      return command(
        `write(${JSON.stringify(path)}, ${JSON.stringify(content.slice(0, 12))}, ${mode})`,
        async (p, memory) => {
          options ??= await ifMatchFor(memory, path, mode);
          return outcome(() => p.write(path, content, options), withoutMtime);
        },
      );
    }),
    pathArb.map((path) =>
      command(`read(${JSON.stringify(path)})`, (p) =>
        outcome(
          () => p.read(path),
          (file) => (file ? withoutMtime(file) : null),
        ),
      ),
    ),
    pathArb.map((path) =>
      command(`stat(${JSON.stringify(path)})`, (p) =>
        outcome(
          () => p.stat(path),
          (entry) => (entry ? withoutMtime(entry) : null),
        ),
      ),
    ),
    fc.tuple(pathArb, ifMatchArb).map(([path, mode]) => {
      let options: WriteOptions | undefined;
      return command(`delete(${JSON.stringify(path)}, ${mode})`, async (p, memory) => {
        options ??= await ifMatchFor(memory, path, mode);
        return outcome(
          () => p.delete(path, options),
          () => "deleted",
        );
      });
    }),
    fc
      .tuple(pathArb, pathArb)
      .map(([from, to]) =>
        command(`rename(${JSON.stringify(from)}, ${JSON.stringify(to)})`, (p) =>
          outcome(() => p.rename(from, to), withoutMtime),
        ),
      ),
    pathArb.map((path) =>
      command(`createFolder(${JSON.stringify(path)})`, (p) =>
        outcome(
          () => p.createFolder(path),
          () => "created",
        ),
      ),
    ),
    pathArb.map((path) =>
      command(`deleteFolder(${JSON.stringify(path)})`, (p) =>
        outcome(
          () => p.deleteFolder(path),
          () => "deleted",
        ),
      ),
    ),
    listOptionsArb.map((options) =>
      command(`list(${JSON.stringify(options)})`, (p) =>
        outcome(
          () => p.list(options),
          (entries) => entries.map(withoutMtime),
        ),
      ),
    ),
    listOptionsArb.map((options) =>
      command(`listFolders(${JSON.stringify(options)})`, (p) =>
        outcome(
          () => p.listFolders(options),
          (f) => f,
        ),
      ),
    ),
  ],
  { maxCommands: 30, size: "max" },
);

/** 30 runs by default; `FC_NUM_RUNS=1000` (a deep sweep) scales it tenfold. */
const RUNS = Math.max(1, Math.round((30 * Number(process.env.FC_NUM_RUNS ?? 100)) / 100));

test.prop([commandsArb], { numRuns: RUNS })(
  "LocalFsStorageProvider behaves exactly like the in-memory reference model",
  async (commands) => {
    const dir = await mkdtemp(join(tmpdir(), "ddl-model-"));
    const local = new LocalFsStorageProvider({ root: join(dir, "vault") });
    const memory = new MemoryStorageProvider({ now: () => 0 });
    const model: Model = { memory, events: [] };
    const real: Real = { local, events: [] };
    memory.watch((event) => model.events.push(event));
    local.watch((event) => real.events.push(event));
    try {
      await local.whenWatchReady();
      await fc.asyncModelRun(() => ({ model, real }), commands);
    } finally {
      await local.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

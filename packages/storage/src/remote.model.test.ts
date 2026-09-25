/**
 * Model-based test: random command sequences run against MemoryStorageProvider (the reference
 * model) and RemoteStorageProvider (a real in-process sync server) must be indistinguishable:
 * same values, sizes, error classes, self events and listings after every step. Versions differ
 * by design (content hashes vs server revs), so they are compared by presence only, and each
 * provider's own current version is used for `ifMatch`.
 */
import { InvalidPathError } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";
import { MemoryStorageProvider } from "./memory";
import type { RemoteStorageProvider } from "./remote";
import { startTestSyncServer } from "./testing/sync-server";
import {
  ConflictError,
  type ListOptions,
  NotFoundError,
  StorageError,
  type StorageEvent,
  type StorageProvider,
  type WriteOptions,
} from "./types";

interface Side {
  provider: StorageProvider;
  events: StorageEvent[];
}

interface Model {
  memory: Side;
}

interface Real {
  remote: Side & { provider: RemoteStorageProvider };
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

type Outcome = { ok: unknown } | { error: string; currentVersion?: "some" | null };

function errorName(error: unknown): string {
  if (error instanceof ConflictError) return "ConflictError";
  if (error instanceof NotFoundError) return "NotFoundError";
  if (error instanceof InvalidPathError) return "InvalidPathError";
  if (error instanceof StorageError) return "StorageError";
  return `unexpected ${String(error)}`;
}

/** Values without the fields that legitimately differ: mtimes, and versions (kept as presence). */
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "mtime") continue;
    out[key] = key === "version" ? typeof field === "string" : comparable(field);
  }
  return out;
}

async function outcome(op: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: comparable(await op()) };
  } catch (error) {
    return error instanceof ConflictError
      ? { error: errorName(error), currentVersion: error.currentVersion === null ? null : "some" }
      : { error: errorName(error) };
  }
}

async function ifMatchFor(provider: StorageProvider, path: string, mode: IfMatch) {
  switch (mode) {
    case "none":
      return {};
    case "null":
      return { ifMatch: null };
    case "stale":
      return { ifMatch: "stale-version" };
    case "current": {
      const current = await provider.stat(path).catch(() => null);
      return { ifMatch: current?.version ?? "missing-version" } satisfies WriteOptions;
    }
  }
}

async function expectSameState(memory: StorageProvider, remote: StorageProvider): Promise<void> {
  for (const includeHidden of [false, true]) {
    const [m, r] = await Promise.all([
      memory.list({ includeHidden }),
      remote.list({ includeHidden }),
    ]);
    expect(comparable(r), `list(includeHidden: ${includeHidden})`).toEqual(comparable(m));
    const [mf, rf] = await Promise.all([
      memory.listFolders({ includeHidden }),
      remote.listFolders({ includeHidden }),
    ]);
    expect(rf, `listFolders(includeHidden: ${includeHidden})`).toEqual(mf);
  }
}

function command(
  label: string,
  run: (provider: StorageProvider) => Promise<Outcome>,
): fc.AsyncCommand<Model, Real> {
  return {
    check: () => true,
    toString: () => label,
    async run(model, real) {
      model.memory.events.length = 0;
      real.remote.events.length = 0;
      const expected = await run(model.memory.provider);
      const actual = await run(real.remote.provider);
      expect(actual, label).toEqual(expected);
      const selfEvents = (side: Side) => comparable(side.events.filter((e) => e.self));
      expect(selfEvents(real.remote), `${label}: self events`).toEqual(selfEvents(model.memory));
      await expectSameState(model.memory.provider, real.remote.provider);
    },
  };
}

const commandsArb = fc.commands(
  [
    fc.tuple(pathArb, contentArb, ifMatchArb).map(([path, content, mode]) =>
      command(
        `write(${JSON.stringify(path)}, ${JSON.stringify(content.slice(0, 12))}, ${mode})`,
        async (p) => {
          const options = await ifMatchFor(p, path, mode);
          return outcome(() => p.write(path, content, options));
        },
      ),
    ),
    pathArb.map((path) =>
      command(`read(${JSON.stringify(path)})`, (p) => outcome(() => p.read(path))),
    ),
    pathArb.map((path) =>
      command(`stat(${JSON.stringify(path)})`, (p) => outcome(() => p.stat(path))),
    ),
    fc.tuple(pathArb, ifMatchArb).map(([path, mode]) =>
      command(`delete(${JSON.stringify(path)}, ${mode})`, async (p) => {
        const options = await ifMatchFor(p, path, mode);
        return outcome(async () => {
          await p.delete(path, options);
          return "deleted";
        });
      }),
    ),
    fc
      .tuple(pathArb, pathArb)
      .map(([from, to]) =>
        command(`rename(${JSON.stringify(from)}, ${JSON.stringify(to)})`, (p) =>
          outcome(() => p.rename(from, to)),
        ),
      ),
    pathArb.map((path) =>
      command(`createFolder(${JSON.stringify(path)})`, (p) =>
        outcome(async () => {
          await p.createFolder(path);
          return "created";
        }),
      ),
    ),
    pathArb.map((path) =>
      command(`deleteFolder(${JSON.stringify(path)})`, (p) =>
        outcome(async () => {
          await p.deleteFolder(path);
          return "deleted";
        }),
      ),
    ),
    listOptionsArb.map((options) =>
      command(`list(${JSON.stringify(options)})`, (p) => outcome(() => p.list(options))),
    ),
    listOptionsArb.map((options) =>
      command(`listFolders(${JSON.stringify(options)})`, (p) =>
        outcome(() => p.listFolders(options)),
      ),
    ),
  ],
  { maxCommands: 30, size: "max" },
);

/** 20 runs by default; `FC_NUM_RUNS=1000` (a deep sweep) scales it tenfold. */
const RUNS = Math.max(1, Math.round((20 * Number(process.env.FC_NUM_RUNS ?? 100)) / 100));

test.prop([commandsArb], { numRuns: RUNS })(
  "RemoteStorageProvider behaves exactly like the in-memory reference model",
  async (commands) => {
    const sync = await startTestSyncServer();
    const memory: Side = { provider: new MemoryStorageProvider({ now: () => 0 }), events: [] };
    const remote = { provider: sync.provider("dev_model"), events: [] as StorageEvent[] };
    memory.provider.watch((event) => memory.events.push(event));
    remote.provider.watch((event) => remote.events.push(event));
    try {
      await fc.asyncModelRun(() => ({ model: { memory }, real: { remote } }), commands);
    } finally {
      await sync.close();
    }
  },
  60_000,
);

import { describe, expect, it, vi } from "vitest";
import {
  decodePersistedRecords,
  encodePersistedRecords,
  PersistedFile,
  type PersistedRecords,
  PersistedWriteConflictError,
} from "../../src/persisted";
import { FakeStorage } from "./fake-storage";

const PATH = ".daily-do-list/state/records.json";
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);
const STAMP = "20260923T120000000Z";
const QUARANTINED = `.daily-do-list/corrupt/state/records.${STAMP}.json`;

const record = (taskId: string, updatedAt = 1) => ({
  taskId,
  notePath: "Daily/2026-09-23.md",
  date: "2026-09-23",
  text: taskId,
  line: 0,
  status: "idle" as const,
  threadId: null,
  updatedAt,
  unread: 0,
});
const state = (...ids: string[]): PersistedRecords => ({
  records: ids.map((id) => record(id)),
  specs: {},
});

function open(storage: FakeStorage, known?: string | null) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  const file = new PersistedFile({
    storage,
    path: PATH,
    decode: decodePersistedRecords,
    now: () => NOW,
    logger,
    ...(known !== undefined ? { known } : {}),
  });
  return { file, logger };
}

describe("PersistedFile.load", () => {
  it("reports a missing file and then creates it only if it is still absent", async () => {
    const storage = new FakeStorage();
    const { file } = open(storage);
    expect(await file.load()).toEqual({ status: "missing" });
    expect(await file.save(() => encodePersistedRecords(state("a")))).toBe("written");
    expect(storage.content(PATH)).toBe(encodePersistedRecords(state("a")));
  });

  it("moves a corrupt file aside with its exact content and treats it as absent", async () => {
    const storage = new FakeStorage({ [PATH]: '{"version":1,"records":[' });
    const { file, logger } = open(storage);
    expect(await file.load()).toEqual({
      status: "quarantined",
      reason: expect.stringContaining("not valid JSON"),
      movedTo: QUARANTINED,
    });
    expect(storage.content(QUARANTINED)).toBe('{"version":1,"records":[');
    expect(storage.content(PATH)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("Moved an unreadable file aside", expect.anything());
    expect(await file.save(() => encodePersistedRecords(state()))).toBe("written");
  });

  it("picks the next free quarantine name on a collision", async () => {
    const storage = new FakeStorage({ [PATH]: "garbage", [QUARANTINED]: "older garbage" });
    const { file } = open(storage);
    expect(await file.load()).toMatchObject({
      movedTo: `.daily-do-list/corrupt/state/records.${STAMP}-2.json`,
    });
    expect(storage.content(QUARANTINED)).toBe("older garbage");
  });

  it("never writes a corrupt file it could not move aside", async () => {
    const storage = new FakeStorage({ [PATH]: "garbage" });
    storage.failRename = new Error("EPERM");
    const { file } = open(storage);
    expect(await file.load()).toMatchObject({ status: "quarantined", movedTo: null });
    expect(file.blocked).toMatch(/could not be moved aside/);
    expect(await file.save(() => encodePersistedRecords(state("a")))).toBe("blocked");
    expect(storage.content(PATH)).toBe("garbage");
  });

  it("leaves a newer version untouched and refuses to write over it", async () => {
    const newer = '{"version":2,"records":{"shape":"from the future"}}';
    const storage = new FakeStorage({ [PATH]: newer });
    const { file } = open(storage);
    expect(await file.load()).toEqual({ status: "newer", version: 2 });
    expect(file.blocked).toMatch(/newer version/);
    expect(await file.save(() => encodePersistedRecords(state("a")))).toBe("blocked");
    expect(storage.paths()).toEqual([PATH]);
    expect(storage.content(PATH)).toBe(newer);
  });

  it("copies the original of a partly invalid file aside right before repairing it", async () => {
    const original = JSON.stringify({
      version: 1,
      records: [record("a"), { taskId: 7 }],
      specs: {},
    });
    const storage = new FakeStorage({ [PATH]: original });
    const { file } = open(storage);
    expect(await file.load()).toEqual({
      status: "loaded",
      value: state("a"),
      fromVersion: 1,
      issues: [{ path: "records[1]", message: expect.any(String) }],
    });
    expect(storage.paths()).toEqual([PATH]);
    expect(await file.save(() => encodePersistedRecords(state("a")))).toBe("written");
    expect(storage.content(QUARANTINED)).toBe(original);
    expect(storage.content(PATH)).toBe(encodePersistedRecords(state("a")));
    await file.save(() => encodePersistedRecords(state("a", "b")));
    expect(storage.paths()).toEqual([QUARANTINED, PATH].sort());
  });

  it("never copies a partly invalid file that is not rewritten", async () => {
    const original = JSON.stringify({ version: 1, records: [{ taskId: 7 }], specs: {} });
    const storage = new FakeStorage({ [PATH]: original });
    await open(storage).file.load();
    await open(storage).file.load();
    expect(storage.paths()).toEqual([PATH]);
  });

  it("does not repair a file whose original could not be copied aside", async () => {
    const original = JSON.stringify({ version: 1, records: [{ taskId: 7 }], specs: {} });
    const storage = new FakeStorage({ [PATH]: original });
    storage.failWrite = (path) => (path.includes("/corrupt/") ? new Error("disk full") : null);
    const { file } = open(storage);
    expect(await file.load()).toMatchObject({ status: "loaded", issues: [{ path: "records[0]" }] });
    expect(await file.save(() => encodePersistedRecords(state()))).toBe("blocked");
    expect(storage.content(PATH)).toBe(original);
  });

  it("lets storage errors through and re-reads before the next write", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("disk")) });
    const read = vi.spyOn(storage, "read").mockRejectedValueOnce(new Error("EIO"));
    const { file } = open(storage);
    await expect(file.load()).rejects.toThrow("EIO");
    const external: PersistedRecords[] = [];
    await file.save(
      () => encodePersistedRecords(state("disk", "mine")),
      (value) => external.push(value),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(external).toEqual([state("disk")]);
    expect(storage.content(PATH)).toBe(encodePersistedRecords(state("disk", "mine")));
  });
});

describe("PersistedFile.save", () => {
  it("writes conditionally and hands a concurrent valid change to the owner before retrying", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("a")) });
    const { file } = open(storage);
    await file.load();
    storage.put(PATH, encodePersistedRecords(state("a", "theirs")));
    let merged = state("a", "ours");
    const result = await file.save(
      () => encodePersistedRecords(merged),
      (theirs) => {
        merged = {
          records: [...merged.records, ...theirs.records.filter((r) => r.taskId === "theirs")],
          specs: {},
        };
      },
    );
    expect(result).toBe("written");
    expect(decodePersistedRecords(storage.content(PATH)!)).toMatchObject({
      value: state("a", "ours", "theirs"),
    });
  });

  it("stops writing when a newer version arrives while running (e.g. through sync)", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("a")) });
    const { file } = open(storage);
    await file.load();
    storage.put(PATH, '{"version":3,"records":[]}');
    expect(await file.save(() => encodePersistedRecords(state("b")))).toBe("blocked");
    expect(storage.content(PATH)).toBe('{"version":3,"records":[]}');
  });

  it("moves aside a file that became corrupt while running, then writes a fresh one", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("a")) });
    const { file } = open(storage);
    await file.load();
    storage.put(PATH, "{broken");
    expect(await file.save(() => encodePersistedRecords(state("a")))).toBe("written");
    expect(storage.content(QUARANTINED)).toBe("{broken");
    expect(storage.content(PATH)).toBe(encodePersistedRecords(state("a")));
  });

  it("recreates a file that was deleted underneath it", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("a")) });
    const { file } = open(storage);
    await file.load();
    storage.files.delete(PATH);
    expect(await file.save(() => encodePersistedRecords(state("a")))).toBe("written");
    expect(storage.content(PATH)).toBe(encodePersistedRecords(state("a")));
  });

  it("gives up with PersistedWriteConflictError when the file never stops changing", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("a")) });
    const { file } = open(storage);
    await file.load();
    storage.beforeWrite = () => storage.put(PATH, encodePersistedRecords(state("churn")));
    await expect(file.save(() => encodePersistedRecords(state("b")))).rejects.toBeInstanceOf(
      PersistedWriteConflictError,
    );
  });

  it("serializes concurrent saves on the same file", async () => {
    const storage = new FakeStorage();
    const { file } = open(storage, null);
    const results = await Promise.all([
      file.save(() => encodePersistedRecords(state("1"))),
      file.save(() => encodePersistedRecords(state("2"))),
      file.save(() => encodePersistedRecords(state("3"))),
    ]);
    expect(results).toEqual(["written", "written", "written"]);
    expect(storage.writes).toHaveLength(3);
    expect(storage.content(PATH)).toBe(encodePersistedRecords(state("3")));
  });

  it("propagates errors thrown by render without writing", async () => {
    const storage = new FakeStorage();
    const { file } = open(storage, null);
    await expect(
      file.save(() => {
        throw new Error("invalid state");
      }),
    ).rejects.toThrow("invalid state");
    expect(storage.writes).toEqual([]);
  });

  it("can move a decodable file aside on request", async () => {
    const storage = new FakeStorage({ [PATH]: encodePersistedRecords(state("a")) });
    const { file } = open(storage);
    await file.load();
    expect(await file.quarantine("belongs to someone else")).toBe(QUARANTINED);
    expect(await file.save(() => encodePersistedRecords(state()))).toBe("written");
  });
});

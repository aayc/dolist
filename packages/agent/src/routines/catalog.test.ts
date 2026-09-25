import { type Logger, routineIdForPath, silentLogger } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineCatalog } from "./catalog";
import { routineFile } from "./test-helpers";

const catalogs: RoutineCatalog[] = [];

function catalog(storage: MemoryStorageProvider, logger: Logger = silentLogger): RoutineCatalog {
  const created = new RoutineCatalog({ storage, logger });
  catalogs.push(created);
  return created;
}

afterEach(() => {
  for (const created of catalogs.splice(0)) created.stop();
});

const VALID = routineFile({ schedule: "every weekday at 7:30", notify: "when changed" });

describe("RoutineCatalog", () => {
  it("lists the routine files of Routines/, sorted by name, and nothing else", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write("Routines/news digest.md", VALID);
    await storage.write("Routines/Morning briefing.md", VALID);
    await storage.write("Routines/Archive/Old.md", VALID);
    await storage.write("Routines/.draft.md", VALID);
    await storage.write("Routines/notes.txt", VALID);
    await storage.write("Notes/Routines.md", VALID);
    const routines = catalog(storage);
    await routines.start();
    expect(routines.list().map((r) => [r.name, r.path])).toEqual([
      ["Morning briefing", "Routines/Morning briefing.md"],
      ["news digest", "Routines/news digest.md"],
    ]);
    const briefing = routines.findByName("MORNING BRIEFING.md");
    expect(briefing).toMatchObject({
      id: routineIdForPath("Routines/Morning briefing.md"),
      file: { schedule: "every weekday at 7:30", notify: "when_changed", problems: [] },
    });
    expect(routines.get(briefing!.id)).toBe(briefing);
  });

  it("picks up routine files as they're created, edited and deleted elsewhere", async () => {
    const storage = new MemoryStorageProvider();
    const routines = catalog(storage);
    await routines.start();
    const changed = vi.fn();
    routines.on(changed);

    storage.simulateExternalChange("Routines/Kettle.md", VALID);
    await vi.waitFor(() => expect(routines.list().map((r) => r.name)).toEqual(["Kettle"]));
    expect(changed).toHaveBeenCalledTimes(1);

    storage.simulateExternalChange(
      "Routines/Kettle.md",
      routineFile({ schedule: "every 2 hours", paused: "true" }),
    );
    await vi.waitFor(() =>
      expect(routines.findByName("Kettle")?.file).toMatchObject({
        schedule: "every 2 hours",
        paused: true,
      }),
    );
    expect(changed).toHaveBeenCalledTimes(2);

    // Rewritten with the same content (a sync pass, a touch): nothing to tell.
    storage.simulateExternalChange(
      "Routines/Kettle.md",
      routineFile({ schedule: "every 2 hours", paused: "true" }),
    );
    await routines.reload("Routines/Kettle.md");
    expect(changed).toHaveBeenCalledTimes(2);

    storage.simulateExternalChange("Routines/Kettle.md", null);
    await vi.waitFor(() => expect(routines.list()).toEqual([]));
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("lists invalid files with what's wrong, without crashing", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write("Routines/No frontmatter.md", "Brief me every morning.\n");
    await storage.write("Routines/Vague.md", routineFile({ schedule: "now and then" }));
    await storage.write("Routines/Too often.md", routineFile({ schedule: "every 5 minutes" }));
    await storage.write(
      "Routines/Odd settings.md",
      routineFile({ schedule: "every day at 9", notify: "loudly", uses: "[web, teleport]" }),
    );
    await storage.write("Routines/Empty.md", "---\nschedule: every day at 9\n---\n");
    await storage.write("Routines/Garbage.md", "---\n\u0000\u0001: ][\n---\n\uFFFD");
    const routines = catalog(storage);
    await routines.start();
    const problems = Object.fromEntries(routines.list().map((r) => [r.name, r.file.problems]));
    expect(Object.keys(problems)).toEqual([
      "Empty",
      "Garbage",
      "No frontmatter",
      "Odd settings",
      "Too often",
      "Vague",
    ]);
    for (const [name, list] of Object.entries(problems)) {
      expect(list.length, name).toBeGreaterThan(0);
    }
    expect(problems["No frontmatter"]![0]).toMatch(/frontmatter/);
    expect(problems["Too often"]!.join(" ")).toMatch(/15/);
    expect(problems["Odd settings"]!.join(" ")).toMatch(/notify/);
    expect(problems["Odd settings"]!.join(" ")).toMatch(/teleport/);
    expect(problems.Empty!.join(" ")).toMatch(/should do/);
  });

  it("keeps the others when a file can't be read, and says so", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write("Routines/Good.md", VALID);
    await storage.write("Routines/Locked.md", VALID);
    const read = storage.read.bind(storage);
    storage.read = async (path) => {
      if (path === "Routines/Locked.md") throw new Error("EACCES: permission denied");
      return read(path);
    };
    const warn = vi.fn();
    const routines = catalog(storage, { ...silentLogger, warn });
    await routines.start();
    expect(routines.list().map((r) => r.name)).toEqual(["Good"]);
    expect(warn).toHaveBeenCalledWith("Failed to read a routine", {
      path: "Routines/Locked.md",
      error: "EACCES: permission denied",
    });
  });

  it("starts empty when the folder can't be listed", async () => {
    const storage = new MemoryStorageProvider();
    storage.list = async () => {
      throw new Error("disk on fire");
    };
    const routines = catalog(storage);
    await expect(routines.start()).resolves.toBeUndefined();
    expect(routines.list()).toEqual([]);
  });
});

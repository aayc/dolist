import { silentLogger } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers";
import { createSync } from "./wiring";

let dir: ReturnType<typeof tempDir> | undefined;

afterEach(() => {
  dir?.cleanup();
});

describe("the sync engine the daemon builds", () => {
  it("keeps machine-local files on this machine: tracker state and the import manifest", async () => {
    dir = tempDir("ddl-wiring-");
    const primary = new MemoryStorageProvider();
    await primary.write("Daily/2026-09-25.md", "- [ ] Call the plumber\n");
    await primary.write(".daily-do-list/import/obsidian.json", '{"version":1}\n');
    await primary.write(".daily-do-list/state/tasks/abc.json", '{"version":1}\n');
    await primary.write(".daily-do-list/state/records.json", '{"version":1}\n');
    const sync = await createSync({
      target: { kind: "local", root: dir.path },
      primary,
      logger: silentLogger,
    });
    await sync!.engine.syncOnce();
    const { target } = sync!;
    expect(await target.read("Daily/2026-09-25.md")).not.toBeNull();
    expect(await target.read(".daily-do-list/state/records.json")).not.toBeNull();
    expect(await target.read(".daily-do-list/import/obsidian.json")).toBeNull();
    expect(await target.read(".daily-do-list/state/tasks/abc.json")).toBeNull();
    await target.dispose();
  });
});

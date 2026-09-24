import { API_ROUTES, type DailyNoteResponse, DEFAULT_DAILY_NOTE_CONTENT } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "../test-helpers";

// 03:30 UTC on Sep 24 is still Sep 23 in Los Angeles: "today" must follow the local calendar.
const NOW = new Date("2026-09-24T03:30:00Z");
let previousTz: string | undefined;

beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
});

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("GET /api/daily/:date", () => {
  it("creates today's note from the template in local time, then returns it unchanged", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: { "Templates/Daily.md": "# {{title}}\n{{date:dddd, MMMM Do}}\n- [ ] " },
    });
    const { request } = await createTestApp({ storage, now: () => NOW });

    const first = await request(API_ROUTES.daily("today"));
    expect(first.status).toBe(200);
    const created = (await first.json()) as DailyNoteResponse;
    expect(created).toMatchObject({
      path: "Daily/2026-09-23.md",
      date: "2026-09-23",
      created: true,
      content: "# 2026-09-23\nWednesday, September 23rd\n- [ ] ",
    });
    expect((await storage.read("Daily/2026-09-23.md"))?.content).toBe(created.content);

    const second = (await (await request(API_ROUTES.daily("today"))).json()) as DailyNoteResponse;
    expect(second).toMatchObject({ created: false, version: created.version });
  });

  it("falls back to the default content when the template is missing", async () => {
    const { request } = await createTestApp({ now: () => NOW });
    const res = await request(API_ROUTES.daily("2026-10-01"));
    expect((await res.json()) as DailyNoteResponse).toMatchObject({
      path: "Daily/2026-10-01.md",
      content: DEFAULT_DAILY_NOTE_CONTENT,
      created: true,
    });
  });

  it("honours the daily-note settings", async () => {
    const storage = new MemoryStorageProvider({ initialFiles: { "tpl.md": "{{date}}" } });
    const { request } = await createTestApp({ storage, now: () => NOW });
    await request(API_ROUTES.settings, {
      method: "PUT",
      json: { dailyNotes: { folder: "Journal/", format: "YYYY/MM/YYYY-MM-DD", template: "tpl" } },
    });
    const note = (await (await request(API_ROUTES.daily("today"))).json()) as DailyNoteResponse;
    expect(note).toMatchObject({ path: "Journal/2026/09/2026-09-23.md", content: "2026-09-23" });
  });

  it("returns 404 without create=1 and never writes", async () => {
    const storage = new MemoryStorageProvider();
    const { request } = await createTestApp({ storage, now: () => NOW });
    const res = await request(API_ROUTES.daily("2026-09-20", false));
    expect(res.status).toBe(404);
    expect(await storage.read("Daily/2026-09-20.md")).toBeNull();
  });

  it("returns the existing note when another writer created it concurrently", async () => {
    const storage = new MemoryStorageProvider();
    const originalWrite = storage.write.bind(storage);
    storage.write = async (path, content, options) => {
      if (path === "Daily/2026-09-23.md" && options?.ifMatch === null) {
        storage.simulateExternalChange(path, "written by Obsidian");
      }
      return originalWrite(path, content, options);
    };
    const { request } = await createTestApp({ storage, now: () => NOW });
    const note = (await (await request(API_ROUTES.daily("today"))).json()) as DailyNoteResponse;
    expect(note).toMatchObject({ created: false, content: "written by Obsidian" });
  });

  it("rejects malformed dates", async () => {
    const { request } = await createTestApp({ now: () => NOW });
    for (const date of ["2026-02-30", "yesterday", "2026-9-1"]) {
      expect((await request(API_ROUTES.daily(date))).status, date).toBe(400);
    }
  });
});

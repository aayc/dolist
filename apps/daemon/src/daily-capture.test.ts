import { PERSISTED_PATHS } from "@ddl/contract";
import { API_ROUTES, WORKSPACE_ID_HEADER } from "@ddl/core";
import { ConflictError, MemoryStorageProvider, type WriteOptions } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./test-helpers";

class InterruptedStorage extends MemoryStorageProvider {
  interrupt: "before-note" | "after-note" | "receipt" | "conflict" | null = null;
  override async write(path: string, content: string, options?: WriteOptions) {
    const step = this.interrupt;
    const note = !path.startsWith(".");
    if (note && step === "before-note") {
      this.interrupt = null;
      throw new Error("crash before write");
    }
    if (note && step === "conflict") {
      this.interrupt = null;
      const result = await super.write(path, "Another client's words\n");
      throw new ConflictError(path, result.version);
    }
    if (
      step === "receipt" &&
      path.startsWith(PERSISTED_PATHS.captures) &&
      JSON.parse(content).phase === "applied"
    ) {
      this.interrupt = null;
      throw new Error("crash persisting receipt");
    }
    const result = await super.write(path, content, options);
    if (note && step === "after-note") {
      this.interrupt = null;
      throw new Error("crash after write");
    }
    return result;
  }
}

async function fixture(storage = new InterruptedStorage()) {
  const t = await createTestApp({ storage, now: () => new Date(2026, 8, 27, 12) });
  const health = await (await t.request(API_ROUTES.health)).json();
  const request = {
    operationId: "capture_one",
    hostId: health.hostId,
    text: "- [ ] Take a synthetic walk",
    capturedAt: 1_790_536_000_000,
    timeZone: "Pacific/Auckland",
  };
  const headers = { [WORKSPACE_ID_HEADER]: health.workspaceId };
  const append = (body = request, date = "2026-09-28", token?: string) =>
    t.request(API_ROUTES.dailyAppend(date), {
      method: "POST",
      json: body,
      headers,
      clientId: "ios_synthetic",
      ...(token ? { token } : {}),
    });
  return { ...t, storage, request, headers, append };
}

describe("daily capture", () => {
  it("binds receipts to the authenticated paired device and normalizes the exact stored UTF-8 base", async () => {
    const t = await fixture();
    const first = await t.devices.add("Synthetic phone one", "app");
    const second = await t.devices.add("Synthetic phone two", "app");
    const request = { ...t.request, text: "- [ ] Synthetic \ud800" };
    const one = await (await t.append(request, "2026-09-28", first.token)).json();
    expect(one.note.content).toContain("Synthetic \ufffd");
    const two = await (await t.append(request, "2026-09-28", second.token)).json();
    expect(two.note.content.match(/Synthetic/g)).toHaveLength(2);
    expect(await (await t.append(request, "2026-09-28", first.token)).json()).toEqual(one);
    await t.devices.revoke(first.device.id);
    expect((await t.append(request, "2026-09-28", first.token)).status).toBe(401);
    expect((await t.storage.read(two.note.path))?.content).toBe(two.note.content);
  });

  it("uses the explicit phone date and template, appends once under concurrent identical retries, returns the original base after later edits", async () => {
    const t = await fixture();
    await t.storage.write("Templates/Daily.md", "# {{date}}\n\n");
    await t.settings.update({ dailyNotes: { folder: "Journal", template: "Templates/Daily.md" } });
    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const response = await t.append();
        expect(response.status).toBe(200);
        return response.json();
      }),
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    const receipt = results[0];
    expect(receipt.outcome).toBe("applied");
    expect(receipt.note.path).toBe("Journal/2026-09-28.md");
    expect(receipt.note.content).toBe("# 2026-09-28\n\n- [ ] Take a synthetic walk\n");
    expect(receipt.hostDate).toBe("2026-09-27");
    expect(receipt.watched).toBe(true);
    await t.storage.write(receipt.note.path, `${receipt.note.content}later typing\n`);
    expect(await (await t.append()).json()).toEqual(receipt);
    expect((await t.storage.read(receipt.note.path))?.content).toContain("later typing");
    expect((await t.append({ ...t.request, text: "different payload" })).status).toBe(409);
    expect((await t.append({ ...t.request, hostId: "other_host" })).status).toBe(412);
    expect((await t.append(t.request, "today")).status).toBe(400);
  });

  it("preserves concurrent text through bounded CAS retry and never changes the capture date for an old capture", async () => {
    const t = await fixture();
    t.storage.interrupt = "conflict";
    const receipt = await (await t.append(t.request, "2020-01-01")).json();
    expect(receipt.outcome).toBe("applied");
    expect(receipt.watched).toBe(false);
    expect(receipt.note.content).toBe("Another client's words\n- [ ] Take a synthetic walk\n");
  });

  it.each(["after-note", "receipt"] as const)(
    "recovers an exact completed write after %s crash and restart without a second append",
    async (step) => {
      const t = await fixture();
      t.storage.interrupt = step;
      expect((await t.append()).status).toBe(500);
      const restart = await fixture(t.storage);
      const response = await restart.append();
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt.outcome).toBe("applied");
      expect(receipt.note.content.match(/Take a synthetic walk/g)).toHaveLength(1);
      expect(await (await restart.append()).json()).toEqual(receipt);
    },
  );

  it.each(["before-note", "after-note"] as const)(
    "reports uncertainty after %s when recovery cannot prove the exact write, and never re-appends",
    async (step) => {
      const t = await fixture();
      t.storage.interrupt = step;
      expect((await t.append()).status).toBe(500);
      const preparedPath = (await t.storage.list({ includeHidden: true })).find((entry) =>
        entry.path.startsWith(PERSISTED_PATHS.captures),
      )!.path;
      const prepared = JSON.parse((await t.storage.read(preparedPath))!.content);
      if (step === "after-note") await t.storage.write(prepared.path, "changed after capture\n");
      const before = await t.storage.read(prepared.path);
      const restart = await fixture(t.storage);
      const receipt = await (await restart.append()).json();
      expect(receipt.outcome).toBe("indeterminate");
      expect(await (await restart.append()).json()).toEqual(receipt);
      expect(await t.storage.read(prepared.path)).toEqual(before);
    },
  );
});

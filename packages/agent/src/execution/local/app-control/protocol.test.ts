import { describe, expect, it } from "vitest";
import {
  HelperProtocolError,
  parseResponse,
  parseRunningApps,
  parseScreenshot,
  parseSetValue,
  parseSnapshot,
} from "./protocol";

describe("parseResponse", () => {
  it("reads results and errors by id", () => {
    expect(parseResponse('{"id":3,"result":{"ok":true}}')).toEqual({ id: 3, result: { ok: true } });
    expect(parseResponse('{"id":4,"error":{"code":"stale","message":"read again"}}')).toEqual({
      id: 4,
      error: { code: "stale", message: "read again" },
    });
  });

  it("ignores lines that aren't responses", () => {
    for (const line of ["", "hello", "[]", '{"result":{}}', '{"id":"1","result":{}}', '{"id":1}']) {
      expect(parseResponse(line)).toBeNull();
    }
  });

  it("maps unknown codes to failed and bounds messages", () => {
    const parsed = parseResponse(
      JSON.stringify({ id: 1, error: { code: "weird", message: "x".repeat(2_000) } }),
    );
    expect(parsed).toMatchObject({ id: 1, error: { code: "failed" } });
    expect((parsed as { error: { message: string } }).error.message).toHaveLength(500);
    expect(parseResponse('{"id":1,"error":{}}')).toMatchObject({
      error: { code: "failed", message: "The computer helper failed (failed)." },
    });
  });
});

describe("result parsers", () => {
  it("reject malformed results instead of guessing", () => {
    expect(() => parseRunningApps({ apps: [{ name: "X" }] })).toThrow(HelperProtocolError);
    expect(() => parseRunningApps({})).toThrow(HelperProtocolError);
    expect(() => parseSnapshot({ snapshotId: "s1" })).toThrow(HelperProtocolError);
    expect(() =>
      parseScreenshot({ image: "", width: 0, height: 10, scale: 1, origin: { x: 0, y: 0 } }),
    ).toThrow(HelperProtocolError);
  });

  it("bound what other apps put in their UI", () => {
    const snapshot = parseSnapshot({
      snapshotId: "s1",
      app: { name: "A".repeat(500), pid: 7 },
      window: { title: "T", frame: { x: 0, y: 0, width: 10, height: 10 } },
      text: "[e1] AXButton",
      elements: [
        {
          id: "e1",
          role: "AXButton",
          name: "n".repeat(500),
          value: "v".repeat(5_000),
          actions: ["press", 3, "confirm"],
          frame: { x: "no" },
        },
      ],
      truncated: "yes",
    });
    expect(snapshot.app.name).toHaveLength(200);
    expect(snapshot.elements[0]!.name).toHaveLength(200);
    expect(snapshot.elements[0]!.value).toHaveLength(1_000);
    expect(snapshot.elements[0]).toMatchObject({
      actions: ["press", "confirm"],
      settable: false,
      enabled: true,
      focused: false,
    });
    expect(snapshot.elements[0]!.frame).toBeUndefined();
    expect(snapshot.truncated).toBe(false);
  });

  it("read set-value results with and without a read-back value", () => {
    expect(parseSetValue({ ok: true, stale: false, value: "hi" })).toEqual({
      stale: false,
      value: "hi",
    });
    expect(parseSetValue({ ok: true })).toEqual({ stale: false });
  });
});

import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { isPersistedArtifactPath, normalizePersistedBase64 } from "../../src/persisted";

describe("isPersistedArtifactPath", () => {
  it.each([
    ".daily-do-list/artifacts/thr_1/art_1.md",
    ".daily-do-list/artifacts/thr_1/art_2.png.b64",
    ".daily-do-list/artifacts/thr_1/nested/art_3.txt",
  ])("accepts %s", (path) => {
    expect(isPersistedArtifactPath(path)).toBe(true);
  });

  it.each([
    "Notes/secret.md",
    ".daily-do-list/state/approvals.json",
    ".daily-do-list/artifacts/art_1.md",
    ".daily-do-list/artifacts/thr_1/../../state/records.json",
    ".daily-do-list/artifacts/thr_1/./art.md",
    ".daily-do-list/artifacts//art.md",
    ".daily-do-list/artifacts/thr_1\\..\\x.md",
    ".daily-do-list/artifacts/thr_1/art\0.md",
    "/.daily-do-list/artifacts/thr_1/art.md",
    "",
  ])("rejects %j", (path) => {
    expect(isPersistedArtifactPath(path)).toBe(false);
  });
});

describe("normalizePersistedBase64", () => {
  const bytes = fc.uint8Array({ maxLength: 300 });

  test.prop([bytes])("accepts what Buffer writes and decodes back to the same bytes", (data) => {
    const encoded = Buffer.from(data).toString("base64");
    const normalized = normalizePersistedBase64(encoded);
    expect(normalized).toBe(encoded);
    expect([...Buffer.from(normalized!, "base64")]).toEqual([...data]);
  });

  test.prop([bytes])("tolerates MIME line breaks and missing padding", (data) => {
    const encoded = Buffer.from(data).toString("base64");
    const wrapped = encoded.replace(/.{1,76}/g, "$&\r\n");
    expect(normalizePersistedBase64(wrapped)).toBe(encoded);
    expect(normalizePersistedBase64(encoded.replace(/=+$/, ""))).toBe(encoded);
  });

  it.each([
    ["url-safe alphabet", "ab-_"],
    ["padding in the middle", "QQ==QQ=="],
    ["an impossible length", "QUJDR"],
    ["misplaced padding", "QQ="],
    ["too much padding", "Q==="],
    ["punctuation", "QUJD!"],
  ])("rejects %s", (_label, text) => {
    expect(normalizePersistedBase64(text)).toBeNull();
  });

  it("accepts an empty body (a zero-byte file)", () => {
    expect(normalizePersistedBase64("")).toBe("");
    expect(normalizePersistedBase64("\n")).toBe("");
  });
});

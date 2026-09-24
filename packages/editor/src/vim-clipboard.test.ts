import { describe, expect, it, vi } from "vitest";
import {
  type ClipboardAccess,
  ClipboardRegister,
  mirrorsUnnamed,
  SystemClipboard,
} from "./vim-clipboard";

function fakeAccess(initial = "", options: { denyRead?: boolean; denyWrite?: boolean } = {}) {
  let text = initial;
  const access: ClipboardAccess & { text(): string } = {
    writeText: vi.fn(async (next: string) => {
      if (options.denyWrite) throw new DOMException("denied", "NotAllowedError");
      text = next;
    }),
    readText: vi.fn(async () => {
      if (options.denyRead) throw new DOMException("denied", "NotAllowedError");
      return text;
    }),
    text: () => text,
  };
  return access;
}

describe("SystemClipboard", () => {
  it("writes through and keeps the shape of what vim wrote", async () => {
    const access = fakeAccess();
    const clipboard = new SystemClipboard(
      () => access,
      async () => true,
    );
    clipboard.write({ text: "a line\n", linewise: true, blockwise: false });
    expect(access.text()).toBe("a line\n");
    await clipboard.refresh(false);
    expect(clipboard.content).toEqual({ text: "a line\n", linewise: true, blockwise: false });
    clipboard.write({ text: "ab\ncd", linewise: false, blockwise: true });
    expect(clipboard.content.blockwise).toBe(true);
  });

  it("sees text copied elsewhere, linewise when it ends with a line break", async () => {
    const access = fakeAccess("elsewhere\n");
    const clipboard = new SystemClipboard(
      () => access,
      async () => true,
    );
    clipboard.write({ text: "from vim", linewise: false, blockwise: false });
    await access.writeText("copied in another app\n");
    await clipboard.refresh(false);
    expect(clipboard.content).toEqual({
      text: "copied in another app\n",
      linewise: true,
      blockwise: false,
    });
    clipboard.observe("pasted text");
    expect(clipboard.content).toEqual({ text: "pasted text", linewise: false, blockwise: false });
  });

  it("only reads in the background with permission; explicit reads may prompt", async () => {
    const access = fakeAccess("secret");
    const clipboard = new SystemClipboard(
      () => access,
      async () => false,
    );
    await clipboard.refresh(false);
    expect(access.readText).not.toHaveBeenCalled();
    expect(clipboard.content.text).toBe("");
    await clipboard.refresh(true);
    expect(clipboard.content.text).toBe("secret");
  });

  it("falls back to what vim yanked when reading or writing is denied", async () => {
    const access = fakeAccess("", { denyRead: true, denyWrite: true });
    const clipboard = new SystemClipboard(
      () => access,
      async () => true,
    );
    clipboard.write({ text: "kept", linewise: false, blockwise: false });
    await clipboard.refresh(true);
    expect(clipboard.content.text).toBe("kept");
  });

  it("works without any clipboard API", async () => {
    const clipboard = new SystemClipboard(
      () => undefined,
      async () => true,
    );
    clipboard.write({ text: "local", linewise: false, blockwise: false });
    await clipboard.refresh(true);
    expect(clipboard.content.text).toBe("local");
  });
});

describe("ClipboardRegister", () => {
  it("implements vim.js's register interface on top of the clipboard", () => {
    const clipboard = new SystemClipboard(
      () => undefined,
      async () => false,
    );
    const register = new ClipboardRegister(clipboard);
    register.setText("one", false, false);
    expect(register.toString()).toBe("one");
    expect(register.keyBuffer).toEqual(["one"]);
    register.pushText("two", true);
    expect(register.toString()).toBe("one\ntwo");
    expect(register.linewise).toBe(true);
    register.pushSearchQuery("q");
    register.clear();
    expect(register.toString()).toBe("");
    expect(register.searchQueries).toEqual([]);
  });
});

describe("mirrorsUnnamed", () => {
  it("recognizes Vim's clipboard option values", () => {
    expect(mirrorsUnnamed("unnamed")).toBe(true);
    expect(mirrorsUnnamed("unnamedplus")).toBe(true);
    expect(mirrorsUnnamed("autoselect,unnamed")).toBe(true);
    expect(mirrorsUnnamed("")).toBe(false);
    expect(mirrorsUnnamed(undefined)).toBe(false);
  });
});

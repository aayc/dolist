import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ComputerPermissionError, ComputerUnavailableError, ExecutionError } from "../errors";
import type { Frame } from "../util/frame-hub";
import { computeScale, scrollSteps, toImagePixel, toScreenPoint } from "./computer-geometry";
import {
  formatKeyCombo,
  KeyComboError,
  keyComboEvents,
  parseKeyCombo,
  typingSteps,
} from "./computer-keys";
import {
  createComputerController,
  MacComputerController,
  permissionHelp,
  UnsupportedComputerController,
} from "./computer-macos";
import {
  ACCESSIBILITY_DENIED,
  CommandError,
  type CommandRunner,
  encodeJxaArgs,
  INPUT_SCRIPT,
  PERMISSIONS_SCRIPT,
  SCREEN_SIZE_SCRIPT,
} from "./jxa";

const CMD = 0x100000;
const SHIFT = 0x20000;
const CTRL = 0x40000;
const ALT = 0x80000;

describe("parseKeyCombo", () => {
  it("parses modifiers and keys", () => {
    expect(parseKeyCombo("cmd+shift+4")).toEqual({
      modifiers: ["cmd", "shift"],
      key: "4",
      code: 21,
      flags: CMD | SHIFT,
    });
    expect(parseKeyCombo("Enter")).toMatchObject({
      modifiers: [],
      key: "enter",
      code: 36,
      flags: 0,
    });
    expect(parseKeyCombo("ctrl+alt+delete")).toMatchObject({ code: 51, flags: CTRL | ALT });
    expect(parseKeyCombo("Command-C")).toMatchObject({ modifiers: ["cmd"], key: "c", code: 8 });
    expect(parseKeyCombo("option + left")).toMatchObject({ modifiers: ["alt"], code: 123 });
    expect(parseKeyCombo("F12")).toMatchObject({ code: 111 });
    expect(parseKeyCombo("esc").code).toBe(53);
    expect(parseKeyCombo("cmd+,").code).toBe(43);
    expect(parseKeyCombo("-").code).toBe(27);
  });

  it("maps plus to shift+equal", () => {
    expect(parseKeyCombo("cmd++")).toMatchObject({ modifiers: ["cmd", "shift"], code: 24 });
    expect(parseKeyCombo("cmd+plus")).toMatchObject({ flags: CMD | SHIFT });
  });

  it.each(["", "cmd", "ctrl+shift", "cmd+a+b", "hyper+a", "cmd+banana", "cmd++a"])(
    "rejects %j",
    (combo) => {
      expect(() => parseKeyCombo(combo)).toThrow(KeyComboError);
    },
  );

  it("formats combos for display", () => {
    expect(formatKeyCombo(parseKeyCombo("cmd+shift+4"))).toBe("Cmd+Shift+4");
    expect(formatKeyCombo(parseKeyCombo("return"))).toBe("Return");
  });
});

describe("keyComboEvents", () => {
  it("presses modifiers in order and releases them in reverse", () => {
    expect(keyComboEvents(parseKeyCombo("cmd+shift+4"))).toEqual([
      { code: 55, down: true, flags: CMD },
      { code: 56, down: true, flags: CMD | SHIFT },
      { code: 21, down: true, flags: CMD | SHIFT },
      { code: 21, down: false, flags: CMD | SHIFT },
      { code: 56, down: false, flags: CMD },
      { code: 55, down: false, flags: 0 },
    ]);
    expect(keyComboEvents(parseKeyCombo("tab"))).toEqual([
      { code: 48, down: true, flags: 0 },
      { code: 48, down: false, flags: 0 },
    ]);
  });
});

describe("typingSteps", () => {
  it("chunks text without splitting surrogate pairs", () => {
    const steps = typingSteps(`${"a".repeat(19)}😀b`);
    expect(steps).toEqual([{ text: "a".repeat(19) }, { text: "😀b" }]);
    for (const step of typingSteps("😀".repeat(30))) {
      if ("text" in step) expect(step.text.length).toBeLessThanOrEqual(20);
    }
    expect(
      typingSteps("😀".repeat(30))
        .map((s) => ("text" in s ? s.text : ""))
        .join(""),
    ).toBe("😀".repeat(30));
  });

  it("turns newlines and tabs into Return/Tab presses", () => {
    expect(typingSteps("hi\r\nthere\tyou\n")).toEqual([
      { text: "hi" },
      { code: 36 },
      { text: "there" },
      { code: 48 },
      { text: "you" },
      { code: 36 },
    ]);
    expect(typingSteps("")).toEqual([]);
  });
});

describe("coordinate scaling", () => {
  const retina = { width: 1280, height: 827, scale: computeScale(1280, 1728) };

  it("maps screenshot pixels to screen points and back", () => {
    expect(retina.scale).toBeCloseTo(0.7407, 3);
    const point = toScreenPoint(640, 400, retina);
    expect(point).toEqual({ x: 864, y: 540 });
    expect(toImagePixel(point, retina)).toEqual({ x: 640, y: 400 });
    expect(toScreenPoint(10.5, 1, retina)).toEqual({ x: 14.18, y: 1.35 });
    expect(toScreenPoint(0, 0, { width: 1280, height: 800, scale: 1 })).toEqual({ x: 0, y: 0 });
  });

  it("rejects coordinates outside the screenshot or non-numbers", () => {
    expect(() => toScreenPoint(1280, 10, retina)).toThrow(ExecutionError);
    expect(() => toScreenPoint(-1, 10, retina)).toThrow(/outside the last screenshot/);
    expect(() => toScreenPoint(Number.NaN, 10, retina)).toThrow(/must be numbers/);
    expect(() => computeScale(0, 100)).toThrow(ExecutionError);
  });

  it("splits scrolls into bounded wheel events with flipped signs", () => {
    expect(scrollSteps(0, 3)).toEqual([{ dx: 0, dy: -3 }]);
    expect(scrollSteps(-2, -25)).toEqual([
      { dx: 2, dy: 10 },
      { dx: 0, dy: 10 },
      { dx: 0, dy: 5 },
    ]);
    expect(scrollSteps(0, 0)).toEqual([]);
    const huge = scrollSteps(0, 10_000);
    expect(huge.reduce((sum, s) => sum + s.dy, 0)).toBe(-200);
  });
});

describe("JXA argument encoding", () => {
  it("round-trips hostile text as data, never as script source", () => {
    const text = `"; $.system("rm -rf ~"); "\` \${danger} '\n\u2028\u2029 😀 \\`;
    const encoded = encodeJxaArgs({ op: "type", text });
    expect(encoded.startsWith("{")).toBe(true);
    expect(JSON.parse(encoded)).toEqual({ op: "type", text });
    for (const script of [INPUT_SCRIPT, SCREEN_SIZE_SCRIPT, PERMISSIONS_SCRIPT]) {
      expect(script).toContain("function run(");
      expect(script).not.toContain("danger");
    }
    expect(INPUT_SCRIPT).toContain("JSON.parse(argv[0])");
  });

  it("only accepts JSON objects", () => {
    expect(() => encodeJxaArgs({ bad: 1n } as unknown as Record<string, unknown>)).toThrow();
    expect(() => encodeJxaArgs(["-e"] as unknown as Record<string, unknown>)).toThrow(TypeError);
  });
});

describe("platform guards", () => {
  it("reports and refuses computer use off macOS", async () => {
    const computer = createComputerController({ platform: "linux" });
    expect(computer).toBeInstanceOf(UnsupportedComputerController);
    expect(computer.platform).toBe("unsupported");
    const status = await computer.check();
    expect(status.ok).toBe(false);
    expect(status.problem).toContain("only available on macOS (this machine runs linux)");
    await expect(computer.screenshot()).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(computer.click(1, 1)).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(computer.type("x")).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(computer.key("enter")).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(computer.move(1, 1)).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(computer.scroll(0, 1)).rejects.toBeInstanceOf(ComputerUnavailableError);
    const unsubscribe = computer.onFrame(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it("creates the macOS controller on darwin", () => {
    expect(createComputerController({ platform: "darwin" }).platform).toBe("macos");
  });
});

/** Fake jpeg bytes: SOI + SOF0 with the given size. */
function jpegBytes(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

interface Call {
  file: string;
  args: readonly string[];
}

/** Scripted stand-in for screencapture/sips/osascript on a 1728×1117pt Retina display. */
function fakeMac(options: { accessibility?: boolean; screenRecording?: boolean | null } = {}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (file === "screencapture") {
      await writeFile(args.at(-1) ?? "", jpegBytes(3456, 2234));
      return { stdout: "", stderr: "" };
    }
    if (file === "sips") {
      await writeFile(args.at(-1) ?? "", jpegBytes(1280, 827));
      return { stdout: "", stderr: "" };
    }
    const script = args[3];
    if (script === SCREEN_SIZE_SCRIPT)
      return { stdout: '{"width":1728,"height":1117}\n', stderr: "" };
    if (script === PERMISSIONS_SCRIPT) {
      const status = {
        accessibility: options.accessibility ?? true,
        screenRecording: options.screenRecording === undefined ? true : options.screenRecording,
      };
      return { stdout: `${JSON.stringify(status)}\n`, stderr: "" };
    }
    if (script === INPUT_SCRIPT) {
      if (options.accessibility === false) {
        throw new CommandError(
          "osascript failed",
          `execution error: Error: ${ACCESSIBILITY_DENIED} (-2700)`,
        );
      }
      return { stdout: "ok\n", stderr: "" };
    }
    throw new Error(`unexpected command ${file}`);
  };
  const inputs = () =>
    calls
      .filter((c) => c.file === "osascript" && c.args[3] === INPUT_SCRIPT)
      .map((c) => JSON.parse(c.args[4] ?? "{}") as Record<string, unknown>);
  return { runner, calls, inputs };
}

describe("MacComputerController (scripted system commands)", () => {
  it("takes downscaled screenshots and derives the pixel/point scale", async () => {
    const mac = fakeMac();
    const computer = new MacComputerController({ runner: mac.runner, settleMs: 0 });
    const frames: Frame[] = [];
    computer.onFrame((frame) => frames.push(frame));
    const shot = await computer.screenshot();
    expect(shot).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 827 });
    expect(shot.scale).toBeCloseTo(1280 / 1728, 6);
    expect(mac.calls.map((c) => c.file).sort()).toEqual(["osascript", "screencapture", "sips"]);
    expect(mac.calls.find((c) => c.file === "sips")?.args.slice(0, 2)).toEqual(["-Z", "1280"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.action).toEqual({ kind: "screenshot" });
  });

  it("requires a screenshot before pointing and maps coordinates to points", async () => {
    const mac = fakeMac();
    const computer = new MacComputerController({ runner: mac.runner, settleMs: 0 });
    await expect(computer.click(10, 10)).rejects.toThrow(/computer_screenshot first/);
    await computer.screenshot();
    await computer.click(640, 400, { double: true });
    await computer.click(100, 100, { button: "right" });
    await computer.move(1279, 826);
    await expect(computer.click(2000, 10)).rejects.toThrow(/outside the last screenshot/);
    expect(mac.inputs()).toEqual([
      { op: "click", x: 864, y: 540, button: "left", clicks: 2 },
      { op: "click", x: 135, y: 135, button: "right", clicks: 1 },
      { op: "move", x: 1726.65, y: 1115.1 },
    ]);
  });

  it("sends typing, key combos and scrolls as precomputed steps", async () => {
    const mac = fakeMac();
    const computer = new MacComputerController({ runner: mac.runner, settleMs: 0 });
    await computer.type("hi\nyou");
    await computer.key("cmd+s");
    await computer.scroll(0, 3);
    await expect(computer.key("cmd+banana")).rejects.toBeInstanceOf(ExecutionError);
    expect(mac.inputs()).toEqual([
      { op: "type", steps: [{ text: "hi" }, { code: 36 }, { text: "you" }] },
      {
        op: "keys",
        events: [
          { code: 55, down: true, flags: CMD },
          { code: 1, down: true, flags: CMD },
          { code: 1, down: false, flags: CMD },
          { code: 55, down: false, flags: 0 },
        ],
      },
      { op: "scroll", steps: [{ dx: 0, dy: -3 }] },
    ]);
  });

  it("emits a frame after each action with overlay coordinates, only while watched", async () => {
    const mac = fakeMac();
    const computer = new MacComputerController({ runner: mac.runner, settleMs: 0 });
    await computer.screenshot();
    const captureCount = () => mac.calls.filter((c) => c.file === "screencapture").length;
    await computer.click(640, 400);
    expect(captureCount()).toBe(1);

    const frames: Frame[] = [];
    const unsubscribe = computer.onFrame((frame) => frames.push(frame));
    await computer.click(640, 400);
    await computer.key("return");
    unsubscribe();
    expect(frames.map((f) => f.action)).toEqual([
      { kind: "click", x: 640, y: 400 },
      { kind: "key", text: "Return" },
    ]);
    expect(captureCount()).toBe(3);
  });

  it("maps missing Accessibility to a permission error with instructions", async () => {
    const mac = fakeMac({ accessibility: false });
    const computer = new MacComputerController({ runner: mac.runner, settleMs: 0 });
    const error = await computer.type("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerPermissionError);
    expect((error as Error).message).toContain("Privacy & Security → Accessibility");
  });

  it("checks permissions and explains what is missing", async () => {
    const ok = new MacComputerController({ runner: fakeMac().runner });
    expect(await ok.check()).toEqual({ ok: true });

    const missing = new MacComputerController({
      runner: fakeMac({ accessibility: false, screenRecording: false }).runner,
    });
    const result = await missing.check();
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("Accessibility");
    expect(result.problem).toContain("Screen & System Audio Recording");

    const unknown = fakeMac({ screenRecording: null });
    const probed = new MacComputerController({ runner: unknown.runner });
    expect(await probed.check()).toEqual({ ok: true });
    expect(unknown.calls.some((c) => c.file === "screencapture")).toBe(true);
  });

  it("builds permission help for only the missing permissions", () => {
    expect(permissionHelp(["screen"])).not.toContain("Accessibility (to move");
    expect(permissionHelp(["accessibility"])).not.toContain("Screen Recording");
  });
});

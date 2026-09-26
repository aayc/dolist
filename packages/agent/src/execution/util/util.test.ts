import { describe, expect, it, vi } from "vitest";
import { type Frame, FrameHub } from "./frame-hub";
import { jpegSize, jpegSizeFromBase64 } from "./jpeg";
import { Mutex } from "./mutex";

/** Minimal JPEG header: SOI, an APP0 segment, then a baseline SOF0 carrying the dimensions. */
function fakeJpeg(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
  const sofSegment = [
    0xff,
    sof,
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
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...sofSegment, 0xff, 0xd9]);
}

const frame = (n: number): Frame => ({
  mimeType: "image/jpeg",
  data: String(n),
  width: 1,
  height: 1,
  ts: n,
});

describe("jpegSize", () => {
  it("reads dimensions from baseline and progressive headers", () => {
    expect(jpegSize(fakeJpeg(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(jpegSize(fakeJpeg(3456, 2234, 0xc2))).toEqual({ width: 3456, height: 2234 });
  });

  it("rejects non-JPEG and truncated data", () => {
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeUndefined();
    expect(jpegSize(fakeJpeg(10, 10).subarray(0, 14))).toBeUndefined();
    expect(jpegSize(new Uint8Array())).toBeUndefined();
  });

  it("works on base64 data", () => {
    expect(jpegSizeFromBase64(fakeJpeg(640, 480).toString("base64"))).toEqual({
      width: 640,
      height: 480,
    });
  });
});

describe("Mutex", () => {
  it("runs sections one at a time in order, surviving failures", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a:end");
    });
    const failing = mutex.run(async () => {
      order.push("b");
      throw new Error("boom");
    });
    const last = mutex.run(async () => {
      order.push("c");
      return 42;
    });
    expect(mutex.busy).toBe(true);
    await slow;
    await expect(failing).rejects.toThrow("boom");
    await expect(last).resolves.toBe(42);
    expect(order).toEqual(["a:start", "a:end", "b", "c"]);
    await Promise.resolve();
    expect(mutex.busy).toBe(false);
  });
});

describe("FrameHub", () => {
  it("calls lifecycle hooks on first subscribe and last unsubscribe", () => {
    const onFirst = vi.fn();
    const onLast = vi.fn();
    const hub = new FrameHub({ onFirst, onLast });
    const a = hub.subscribe(() => {});
    const b = hub.subscribe(() => {});
    expect(onFirst).toHaveBeenCalledTimes(1);
    a();
    a();
    expect(onLast).not.toHaveBeenCalled();
    b();
    expect(onLast).toHaveBeenCalledTimes(1);
    expect(hub.size).toBe(0);
  });

  it("isolates failing listeners and allows duplicate subscriptions", () => {
    const hub = new FrameHub();
    const seen: number[] = [];
    const listener = (f: Frame) => seen.push(f.ts);
    hub.subscribe(() => {
      throw new Error("bad listener");
    });
    const first = hub.subscribe(listener);
    hub.subscribe(listener);
    hub.emit(frame(1));
    first();
    hub.emit(frame(2));
    expect(seen).toEqual([1, 1, 2]);
    hub.clear();
    hub.emit(frame(3));
    expect(seen).toEqual([1, 1, 2]);
  });
});

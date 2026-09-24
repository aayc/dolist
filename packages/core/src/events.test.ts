import { fc, test } from "@fast-check/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "./events";

type Events = { ping: number; other: string };

/** Captures errors the emitter reports asynchronously (it rethrows them in a microtask). */
function captureReported(): unknown[] {
  const reported: unknown[] = [];
  vi.stubGlobal("queueMicrotask", (task: () => void) => {
    try {
      task();
    } catch (error) {
      reported.push(error);
    }
  });
  return reported;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Emitter", () => {
  it("delivers to subscribers of that event until they unsubscribe", () => {
    const e = new Emitter<Events>();
    const got: number[] = [];
    const off = e.on("ping", (n) => got.push(n));
    e.on("other", () => got.push(-1));
    e.emit("ping", 1);
    off();
    off();
    e.emit("ping", 2);
    expect(got).toEqual([1]);
    expect(e.listenerCount("ping")).toBe(0);
    expect(e.listenerCount("other")).toBe(1);
  });

  it("once fires a single time, even when it re-emits", () => {
    const e = new Emitter<Events>();
    const got: number[] = [];
    e.once("ping", (n) => {
      got.push(n);
      e.emit("ping", n + 1);
    });
    e.emit("ping", 1);
    e.emit("ping", 10);
    expect(got).toEqual([1]);
  });

  it("an unsubscribed once listener never fires", () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    const off = e.once("ping", fn);
    off();
    e.emit("ping", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("isolates a throwing listener and reports its error asynchronously", () => {
    const reported = captureReported();
    const e = new Emitter<Events>();
    const got: number[] = [];
    e.on("ping", () => {
      throw new Error("bad listener");
    });
    e.on("ping", (n) => got.push(n));
    expect(() => e.emit("ping", 1)).not.toThrow();
    expect(got).toEqual([1]);
    expect(reported).toEqual([new Error("bad listener")]);
  });

  it("uses snapshot semantics: removals and additions during an emit apply to the next one", () => {
    const e = new Emitter<Events>();
    const got: string[] = [];
    let offB = () => {};
    e.on("ping", (n) => {
      got.push(`a${n}`);
      offB();
      e.on("ping", (m) => got.push(`late${m}`));
    });
    offB = e.on("ping", (n) => got.push(`b${n}`));
    e.emit("ping", 1);
    expect(got).toEqual(["a1", "b1"]);
    got.length = 0;
    e.emit("ping", 2);
    expect(got).toEqual(["a2", "late2"]);
  });

  it("registers the same function once per event", () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    const off1 = e.on("ping", fn);
    e.on("ping", fn);
    e.emit("ping", 1);
    expect(fn).toHaveBeenCalledTimes(1);
    off1();
    e.emit("ping", 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clear drops everything; stale unsubscribes are harmless", () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    const off = e.on("ping", fn);
    e.clear();
    off();
    e.on("ping", fn);
    e.emit("ping", 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  type Op =
    | { kind: "on"; id: number }
    | { kind: "once"; id: number }
    | { kind: "off"; id: number }
    | { kind: "emit"; value: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("on" as const), id: fc.nat({ max: 4 }) }),
    fc.record({ kind: fc.constant("once" as const), id: fc.nat({ max: 4 }) }),
    fc.record({ kind: fc.constant("off" as const), id: fc.nat({ max: 4 }) }),
    fc.record({ kind: fc.constant("emit" as const), value: fc.nat({ max: 99 }) }),
  );

  test.prop([fc.array(opArb, { maxLength: 40 })])("matches a subscription-list model", (ops) => {
    const e = new Emitter<Events>();
    const got: string[] = [];
    const expected: string[] = [];
    const offs = new Map<number, Array<() => void>>();
    let model: Array<{ token: object; id: number; once: boolean }> = [];
    for (const op of ops) {
      if (op.kind === "on" || op.kind === "once") {
        const token = {};
        const listener = (n: number) => got.push(`${op.id}:${n}`);
        const off = op.kind === "on" ? e.on("ping", listener) : e.once("ping", listener);
        offs.set(op.id, [...(offs.get(op.id) ?? []), off]);
        model.push({ token, id: op.id, once: op.kind === "once" });
        const entry = model.at(-1)!;
        offs.get(op.id)!.push(() => {
          model = model.filter((m) => m !== entry);
        });
      } else if (op.kind === "off") {
        for (const off of offs.get(op.id) ?? []) off();
        offs.delete(op.id);
      } else {
        e.emit("ping", op.value);
        for (const m of model) expected.push(`${m.id}:${op.value}`);
        model = model.filter((m) => !m.once);
      }
      expect(got).toEqual(expected);
      expect(e.listenerCount("ping")).toBe(model.length);
    }
  });
});

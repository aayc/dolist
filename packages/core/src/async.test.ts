import { fc, test } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce, deferred, raceAbort, sleep, TimeoutError, withTimeout } from "./async";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debounce", () => {
  it("runs once with the last arguments after the quiet period", () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(1);
    vi.advanceTimersByTime(60);
    d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fn.mock.calls).toEqual([[2]]);
    expect(d.pending).toBe(false);
  });

  it("flush runs pending work now; flush with nothing pending and cancel do nothing", () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d.flush();
    d(1);
    d.flush();
    d.flush();
    d(2);
    d.cancel();
    vi.advanceTimersByTime(1_000);
    expect(fn.mock.calls).toEqual([[1]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows re-entrant calls from the debounced function", () => {
    const calls: number[] = [];
    const d = debounce((n: number) => {
      calls.push(n);
      if (n < 3) d(n + 1);
    }, 10);
    d(1);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("stays usable after the function throws during flush", () => {
    const fn = vi.fn((n: number) => {
      if (n === 1) throw new Error("boom");
    });
    const d = debounce(fn, 10);
    d(1);
    expect(() => d.flush()).toThrow("boom");
    expect(d.pending).toBe(false);
    d(2);
    vi.advanceTimersByTime(10);
    expect(fn.mock.calls).toEqual([[1], [2]]);
  });

  type Op =
    | { kind: "call"; arg: number }
    | { kind: "advance"; ms: number }
    | { kind: "flush" }
    | { kind: "cancel" };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({ kind: fc.constant("call" as const), arg: fc.nat({ max: 99 }) }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("advance" as const),
        ms: fc.integer({ min: 0, max: 80 }),
      }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "flush" as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: "cancel" as const }) },
  );

  test.prop([fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 1, max: 60 })])(
    "matches a trailing-edge model under any sequence of calls, time, flushes and cancels",
    (ops, wait) => {
      const fired: number[] = [];
      const d = debounce((n: number) => fired.push(n), wait);
      const expected: number[] = [];
      let pending: { arg: number; due: number } | null = null;
      let now = 0;
      for (const op of ops) {
        switch (op.kind) {
          case "call":
            d(op.arg);
            pending = { arg: op.arg, due: now + wait };
            break;
          case "advance":
            vi.advanceTimersByTime(op.ms);
            now += op.ms;
            if (pending && pending.due <= now) {
              expected.push(pending.arg);
              pending = null;
            }
            break;
          case "flush":
            d.flush();
            if (pending) expected.push(pending.arg);
            pending = null;
            break;
          case "cancel":
            d.cancel();
            pending = null;
            break;
        }
        expect(d.pending).toBe(pending !== null);
      }
      expect(fired).toEqual(expected);
    },
  );
});

describe("withTimeout", () => {
  it("resolves with the value and clears its timer", async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the original rejection through", async () => {
    await expect(withTimeout(Promise.reject(new Error("nope")), 50)).rejects.toThrow("nope");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with TimeoutError when the promise is too slow", async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 1_000));
    const raced = withTimeout(slow, 50, "too slow");
    const check = expect(raced).rejects.toMatchObject({
      name: "TimeoutError",
      message: "too slow",
    });
    await vi.advanceTimersByTimeAsync(50);
    await check;
    const never = expect(withTimeout(new Promise<never>(() => {}), 0)).rejects.toBeInstanceOf(
      TimeoutError,
    );
    await vi.advanceTimersByTimeAsync(0);
    await never;
  });

  it("an already-settled promise wins even with a zero timeout", async () => {
    await expect(withTimeout(Promise.resolve("ready"), 0)).resolves.toBe("ready");
  });
});

describe("deferred", () => {
  it("tracks settlement and ignores later resolutions", async () => {
    const d = deferred<number>();
    expect(d.settled).toBe(false);
    d.resolve(1);
    d.resolve(2);
    d.reject(new Error("late"));
    expect(d.settled).toBe(true);
    await expect(d.promise).resolves.toBe(1);
  });

  it("rejects", async () => {
    const d = deferred<number>();
    d.reject(new Error("x"));
    await expect(d.promise).rejects.toThrow("x");
    expect(d.settled).toBe(true);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    let done = false;
    const s = sleep(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await s;
    expect(done).toBe(true);
  });

  it("rejects at once with the reason when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(sleep(100, controller.signal)).rejects.toThrow("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on abort and clears its timer; aborting after it resolved is harmless", async () => {
    const controller = new AbortController();
    const s = sleep(100, controller.signal);
    controller.abort();
    await expect(s).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);

    const later = new AbortController();
    const ok = sleep(10, later.signal);
    await vi.advanceTimersByTimeAsync(10);
    await expect(ok).resolves.toBeUndefined();
    expect(() => later.abort()).not.toThrow();
  });
});

describe("raceAbort", () => {
  it("passes through results without a signal", async () => {
    await expect(raceAbort(Promise.resolve(1), undefined)).resolves.toBe(1);
  });

  it("rejects as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const never = new Promise<number>(() => {});
    const raced = raceAbort(never, controller.signal);
    controller.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately for an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(raceAbort(Promise.resolve(1), controller.signal)).rejects.toThrow("stop");
  });
});

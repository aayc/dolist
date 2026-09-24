import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./keyed-mutex";
import { createLimiter } from "./limiter";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("KeyedMutex", () => {
  it("serializes work per key in call order and runs other keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const task = (key: string, label: string) =>
      mutex.run(key, async () => {
        log.push(`start ${label}`);
        await tick();
        log.push(`end ${label}`);
      });
    await Promise.all([task("a", "a1"), task("a", "a2"), task("b", "b1")]);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("start b1")).toBeLessThan(log.indexOf("end a1"));
    expect(mutex.size).toBe(0);
  });

  it("releases the key when the work throws", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(mutex.run("a", async () => "ok")).resolves.toBe("ok");
  });

  it("holds several keys without deadlocking opposite orders", async () => {
    const mutex = new KeyedMutex();
    const results = await Promise.all([
      mutex.runAll(["x", "y"], async () => {
        await tick();
        return 1;
      }),
      mutex.runAll(["y", "x"], async () => {
        await tick();
        return 2;
      }),
      mutex.runAll(["x", "x"], async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });
});

describe("createLimiter", () => {
  it("never runs more than the limit at once", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it("keeps going after failures", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limit(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects invalid limits", () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
  });
});

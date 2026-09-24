import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { KeyedMutex } from "./keyed-mutex";
import { createLimiter } from "./limiter";

const tick = (turns: number) => {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => undefined);
  return p;
};

describe("KeyedMutex under random schedules", () => {
  const jobArb = fc.record({
    keys: fc.uniqueArray(fc.constantFrom<string>("a", "b", "c"), { minLength: 1, maxLength: 3 }),
    turns: fc.nat({ max: 5 }),
    fails: fc.boolean(),
  });

  test.prop([fc.array(jobArb, { minLength: 1, maxLength: 12 })])(
    "never overlaps work on a key, runs each key's work in call order, and frees idle keys",
    async (jobs) => {
      const mutex = new KeyedMutex();
      const holders = new Map<string, number>();
      const order = new Map<string, number[]>();
      const runs = jobs.map((job, id) => {
        const work = async () => {
          for (const key of job.keys) {
            expect(holders.get(key), `key ${key} held twice`).toBeUndefined();
            holders.set(key, id);
            order.set(key, [...(order.get(key) ?? []), id]);
          }
          await tick(job.turns);
          for (const key of job.keys) holders.delete(key);
          if (job.fails) throw new Error(`job ${id}`);
          return id;
        };
        return job.keys.length === 1 ? mutex.run(job.keys[0]!, work) : mutex.runAll(job.keys, work);
      });
      const results = await Promise.allSettled(runs);
      expect(results.map((r) => r.status)).toEqual(
        jobs.map((job) => (job.fails ? "rejected" : "fulfilled")),
      );
      for (const [key, ids] of order) {
        // Single-key jobs keep call order among themselves.
        const single = ids.filter((id) => jobs[id]!.keys.length === 1);
        expect(single).toEqual([...single].sort((x, y) => x - y));
        expect(ids).toHaveLength(jobs.filter((j) => j.keys.includes(key)).length);
      }
      expect(mutex.size).toBe(0);
    },
  );
});

describe("createLimiter under random workloads", () => {
  test.prop([
    fc.integer({ min: 1, max: 5 }),
    fc.array(fc.record({ turns: fc.nat({ max: 6 }), fails: fc.boolean() }), { maxLength: 25 }),
  ])(
    "never exceeds its concurrency, runs everything, and survives failures",
    async (limit, tasks) => {
      const run = createLimiter(limit);
      let active = 0;
      let peak = 0;
      const results = await Promise.allSettled(
        tasks.map((task, i) =>
          run(async () => {
            active++;
            peak = Math.max(peak, active);
            await tick(task.turns);
            active--;
            if (task.fails) throw new Error(`task ${i}`);
            return i;
          }),
        ),
      );
      expect(peak).toBeLessThanOrEqual(limit);
      expect(peak).toBe(Math.min(limit, tasks.length));
      expect(results.map((r) => r.status)).toEqual(
        tasks.map((task) => (task.fails ? "rejected" : "fulfilled")),
      );
      await expect(run(async () => "still works")).resolves.toBe("still works");
    },
  );
});

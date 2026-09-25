import { describe, expect, it } from "vitest";
import { graphemes, revealCount, TypeReveal } from "./reveal";

/*
 * The pacing table is shared with the macOS app (`RevealPacingTests`): same cases, same numbers.
 * `dt` values that land on .5 are exact binary fractions, so both platforms round the same way.
 */
const PACING: ReadonlyArray<{ backlog: number; dt: number; reveal: number; why: string }> = [
  { backlog: 0, dt: 1 / 60, reveal: 0, why: "nothing to reveal" },
  { backlog: 0, dt: 5, reveal: 0, why: "nothing to reveal, however long the frame" },
  { backlog: 1, dt: 0, reveal: 1, why: "the first frame (dt 0) still shows one" },
  { backlog: 10, dt: 1 / 60, reveal: 1, why: "floor speed 45/s: 0.75 rounds to 1" },
  { backlog: 10, dt: 1 / 120, reveal: 1, why: "at least one per frame" },
  { backlog: 10, dt: 0.125, reveal: 6, why: "45 × 0.125 = 5.625" },
  { backlog: 100, dt: 0.125, reveal: 13, why: "speed 100/s: 12.5 rounds half up" },
  { backlog: 100, dt: 1 / 60, reveal: 2, why: "speed 100/s: 1.67" },
  { backlog: 600, dt: 1 / 60, reveal: 10, why: "speed 600/s" },
  { backlog: 3000, dt: 1 / 60, reveal: 50, why: "speed 3000/s" },
  { backlog: 6000, dt: 1 / 60, reveal: 50, why: "capped at 3000/s" },
  { backlog: 6000, dt: 1 / 120, reveal: 25, why: "capped at 3000/s, 120 Hz" },
  { backlog: 5, dt: 1, reveal: 5, why: "never more than the backlog" },
  { backlog: 1000, dt: 2, reveal: 1000, why: "a long frame (hidden tab) catches up" },
  { backlog: 20, dt: -1, reveal: 1, why: "a clock going backwards counts as dt 0" },
];

describe("revealCount (pacing, shared with macOS)", () => {
  it.each(PACING)("backlog $backlog, dt $dt → $reveal ($why)", ({ backlog, dt, reveal }) => {
    expect(revealCount(backlog, dt)).toBe(reveal);
  });

  it("trails a steady stream by about a second", () => {
    for (const perSecond of [120, 600, 2400]) {
      const reveal = new TypeReveal("", 0);
      let text = "";
      let worst = 0;
      for (let frame = 0; frame < 60 * 4; frame++) {
        text += "x".repeat(perSecond / 60);
        reveal.update(text);
        reveal.step(1 / 60);
        if (frame > 60 * 2) worst = Math.max(worst, reveal.backlog / perSecond);
      }
      expect(worst).toBeGreaterThan(0.5);
      expect(worst).toBeLessThan(1.1);
    }
  });

  it("types a short reply out visibly and drains a whole message quickly", () => {
    const framesFor = (total: number) => {
      const reveal = new TypeReveal("", 0);
      reveal.update("x".repeat(total));
      let frames = 0;
      while (!reveal.caughtUp) {
        reveal.step(1 / 60);
        frames++;
      }
      return frames;
    };
    // One per frame below the 45/s floor: half a second for 30 characters at 60 Hz.
    expect(framesFor(30)).toBe(30);
    // The backlog drains exponentially (speed = backlog per second), capped at 3000/s.
    expect(framesFor(200) / 60).toBeGreaterThan(1);
    expect(framesFor(200) / 60).toBeLessThan(2.5);
    const long = framesFor(20_000) / 60;
    expect(long).toBeGreaterThan(20_000 / 3000);
    expect(long).toBeLessThan(11);
  });
});

describe("graphemes", () => {
  it("keeps emoji, skin tones, flags, families and combining marks whole", () => {
    expect(graphemes("a👍🏽🇫🇷👨‍👩‍👧e\u0301")).toEqual(["a", "👍🏽", "🇫🇷", "👨‍👩‍👧", "e\u0301"]);
  });
});

describe("TypeReveal", () => {
  it("shows history at once", () => {
    const reveal = new TypeReveal("Already here");
    expect(reveal.shown).toBe("Already here");
    expect(reveal.caughtUp).toBe(true);
  });

  it("reveals a new message from nothing, one frame at a time", () => {
    const reveal = new TypeReveal("", 0);
    reveal.update("Hello");
    expect(reveal.backlog).toBe(5);
    expect(reveal.step(0)).toBe(1);
    expect(reveal.shown).toBe("H");
    reveal.step(1);
    expect(reveal.shown).toBe("Hello");
    expect(reveal.caughtUp).toBe(true);
    expect(reveal.step(1 / 60)).toBe(0);
  });

  it("starts a message opened mid-stream from what had arrived", () => {
    const reveal = new TypeReveal("Opened while", "Opened while".length);
    reveal.update("Opened while streaming");
    expect(reveal.shown).toBe("Opened while");
    expect(reveal.backlog).toBe(" streaming".length);
  });

  it("counts and cuts by grapheme clusters", () => {
    const reveal = new TypeReveal("", 0);
    reveal.update("👍🏽 ok");
    expect(reveal.backlog).toBe(4);
    reveal.step(0);
    expect(reveal.shown).toBe("👍🏽");
  });

  it("never shows half of a cluster split across two deltas", () => {
    const reveal = new TypeReveal("", 0);
    reveal.update("a👨‍👩");
    reveal.update("a👨‍👩‍👧 b");
    const seen: string[] = [];
    while (!reveal.caughtUp) {
      reveal.step(0);
      seen.push(reveal.shown);
    }
    expect(seen).toEqual(["a", "a👨‍👩‍👧", "a👨‍👩‍👧 ", "a👨‍👩‍👧 b"]);

    const tone = new TypeReveal("", 0);
    tone.update("x👍");
    tone.update("x👍🏽");
    expect(tone.backlog).toBe(2);
  });

  it("keeps revealing after the text stops growing, then matches it exactly", () => {
    const reveal = new TypeReveal("", 0);
    reveal.update("The final text");
    reveal.step(0);
    reveal.update("The final text");
    while (!reveal.caughtUp) reveal.step(1 / 60);
    expect(reveal.shown).toBe("The final text");
  });

  it("keeps the shown part a repaired final text still starts with", () => {
    const reveal = new TypeReveal("", 0);
    reveal.update("Hello wor");
    reveal.step(1);
    expect(reveal.shown).toBe("Hello wor");
    reveal.update("Hello there, world");
    expect(reveal.shown).toBe("Hello ");
    expect(reveal.backlog).toBe("there, world".length);
    reveal.step(1);
    expect(reveal.shown).toBe("Hello there, world");
  });

  it("finish() shows everything received", () => {
    const reveal = new TypeReveal("", 0);
    reveal.update("Reduce motion: no typing");
    reveal.finish();
    expect(reveal.shown).toBe("Reduce motion: no typing");
    expect(reveal.caughtUp).toBe(true);
    reveal.update("Reduce motion: no typing, still");
    expect(reveal.backlog).toBe(", still".length);
  });

  it("stays exact over a long stream of small deltas", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i} `);
    const reveal = new TypeReveal("", 0);
    let text = "";
    for (const word of words) {
      text += word;
      reveal.update(text);
      reveal.step(1 / 60);
      expect(text.startsWith(reveal.shown)).toBe(true);
    }
    while (!reveal.caughtUp) reveal.step(1 / 60);
    expect(reveal.shown).toBe(text);
  });
});

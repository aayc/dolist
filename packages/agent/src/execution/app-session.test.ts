import { describe, expect, it } from "vitest";
import { AppSession, looksLikeBundleId, matchApps, normalizeAppName } from "./app-session";
import type { AppSnapshot } from "./types";

function snapshot(snapshotId: string, pid = 501, name = "Grok Bot"): AppSnapshot {
  return {
    snapshotId,
    app: { name, bundleId: `com.example.${pid}`, pid },
    window: { title: "Grok", frame: { x: 0, y: 0, width: 800, height: 600 } },
    text: [
      '[e1] AXWindow name="Grok"',
      '  [e2] AXTextArea name="Ask [e9] anything" settable',
      '  [e3] AXButton name="Send" actions=press',
    ].join("\n"),
    elements: [
      {
        id: "e1",
        role: "AXWindow",
        name: "Grok",
        settable: false,
        actions: [],
        enabled: true,
        focused: false,
      },
      {
        id: "e2",
        role: "AXTextArea",
        name: "Ask [e9] anything",
        settable: true,
        actions: [],
        enabled: true,
        focused: false,
      },
      {
        id: "e3",
        role: "AXButton",
        name: "Send",
        settable: false,
        actions: ["press"],
        enabled: true,
        focused: false,
      },
    ],
    truncated: false,
  };
}

describe("app names", () => {
  it("normalizes names and recognizes bundle ids", () => {
    expect(normalizeAppName("  Grok   Bot.app ")).toBe("grok bot");
    expect(looksLikeBundleId("com.example.grokbot")).toBe(true);
    expect(looksLikeBundleId("Grok Bot")).toBe(false);
    expect(looksLikeBundleId("zoom.us")).toBe(false);
  });

  it("matches exact names and bundle ids first, then unique prefixes, then contains", () => {
    const apps = [
      { name: "Grok Bot", bundleId: "com.example.grokbot" },
      { name: "Grok (Next)" },
      { name: "WhatsApp" },
      { name: "Microsoft Teams" },
    ];
    expect(matchApps("grok bot", apps).map((a) => a.name)).toEqual(["Grok Bot"]);
    expect(matchApps("COM.EXAMPLE.GROKBOT", apps).map((a) => a.name)).toEqual(["Grok Bot"]);
    expect(matchApps("grok", apps).map((a) => a.name)).toEqual(["Grok Bot", "Grok (Next)"]);
    expect(matchApps("whats", apps).map((a) => a.name)).toEqual(["WhatsApp"]);
    expect(matchApps("teams", apps).map((a) => a.name)).toEqual(["Microsoft Teams"]);
    expect(matchApps("", apps)).toEqual([]);
    expect(matchApps("slack", apps)).toEqual([]);
  });
});

describe("AppSession", () => {
  it("renumbers element ids per thread and never reuses them", () => {
    const session = new AppSession();
    const first = session.addSnapshot(snapshot("s1"));
    expect(first.text).toBe(
      [
        '[e1] AXWindow name="Grok"',
        '  [e2] AXTextArea name="Ask [e9] anything" settable',
        '  [e3] AXButton name="Send" actions=press',
      ].join("\n"),
    );
    const second = session.addSnapshot(snapshot("s2"));
    expect(second.text.split("\n").map((l) => l.trim().slice(0, 4))).toEqual([
      "[e4]",
      "[e5]",
      "[e6]",
    ]);
    expect(session.element("e3")).toMatchObject({ element: { id: "e3", name: "Send" } });
    expect(session.element("e3")!.snapshot.snapshotId).toBe("s1");
    expect(session.element("e6")).toMatchObject({ element: { id: "e3" } });
    expect(session.element("e6")!.snapshot.snapshotId).toBe("s2");
  });

  it("keeps an expansion's ids next to the snapshot it expands", () => {
    const session = new AppSession();
    const { entry } = session.addSnapshot(snapshot("s1"));
    const expanded = session.addSnapshot(
      {
        ...snapshot("s1"),
        text: '[e3] AXButton name="Send"\n  [e10] AXStaticText value="tip"',
        elements: [
          {
            id: "e10",
            role: "AXStaticText",
            value: "tip",
            settable: false,
            actions: [],
            enabled: true,
            focused: false,
          },
        ],
      },
      entry,
    );
    expect(expanded.entry).toBe(entry);
    expect(expanded.text).toBe('[e3] AXButton name="Send"\n  [e4] AXStaticText value="tip"');
    expect(session.element("e4")!.snapshot).toBe(entry);
  });

  it("marks an app's snapshots stale and forgets old ones", () => {
    const session = new AppSession();
    session.addSnapshot(snapshot("s1"));
    session.markStale(501);
    expect(session.element("e1")!.snapshot.stale).toBe(true);
    for (const id of ["s2", "s3", "s4"]) session.addSnapshot(snapshot(id));
    expect(session.element("e1")).toBeUndefined();
    expect(session.element("e4")!.snapshot.stale).toBe(false);
    expect(session.latestSnapshot(501)?.snapshotId).toBe("s4");
  });

  it("finds apps by what the model called them and follows relaunches", () => {
    const session = new AppSession();
    session.rememberApp({ name: "Grok Bot", bundleId: "com.example.grokbot", pid: 501 }, "grok");
    expect(session.findApp("grok")?.pid).toBe(501);
    expect(session.findApp("Grok Bot")?.pid).toBe(501);
    session.addSnapshot(snapshot("s1", 501));
    session.rememberRunning([
      { name: "Grok Bot", bundleId: "com.example.grokbot", pid: 777, active: true, hidden: false },
      { name: "WhatsApp", pid: 502, active: false, hidden: false },
    ]);
    expect(session.findApp("grok")?.pid).toBe(777);
    expect(session.element("e1")).toBeUndefined();
    expect(session.findApp("whatsapp")?.pid).toBe(502);
    session.rememberRunning([]);
    expect(session.findApp("grok")).toBeUndefined();
  });

  it("remembers the geometry of each app's last screenshot", () => {
    const session = new AppSession();
    session.rememberShot(501, { width: 900, height: 700, scale: 2, origin: { x: 10, y: 20 } });
    expect(session.shot(501)).toEqual({
      width: 900,
      height: 700,
      scale: 2,
      origin: { x: 10, y: 20 },
    });
    expect(session.shot(502)).toBeUndefined();
  });
});

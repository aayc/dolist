import { describe, expect, it } from "vitest";
import { discoverDrawingRenderer } from "./drawing-renderer";

const pages =
  (...dirs: string[]) =>
  (dir: string) =>
    dirs.includes(dir);

describe("discoverDrawingRenderer", () => {
  const base = { cwd: "/work", entryScript: "/app/daemon/dist/main.js", builds: ["/repo/dist/r"] };

  it("finds the page next to the entry script, then the daemon's dist", () => {
    expect(
      discoverDrawingRenderer({
        ...base,
        env: {},
        isPage: pages("/app/daemon/dist/drawing-renderer", "/repo/dist/r"),
      }),
    ).toEqual({ path: "/app/daemon/dist/drawing-renderer" });
    expect(discoverDrawingRenderer({ ...base, env: {}, isPage: pages("/repo/dist/r") })).toEqual({
      path: "/repo/dist/r",
    });
    expect(discoverDrawingRenderer({ ...base, env: {}, isPage: pages() })).toEqual({
      problem: expect.stringContaining("not built"),
    });
  });

  it("takes DDL_DRAWING_RENDERER, which can also turn rendering off", () => {
    const isPage = pages("/work/page", "/app/daemon/dist/drawing-renderer");
    expect(
      discoverDrawingRenderer({ ...base, env: { DDL_DRAWING_RENDERER: "page" }, isPage }),
    ).toEqual({ path: "/work/page" });
    expect(
      discoverDrawingRenderer({ ...base, env: { DDL_DRAWING_RENDERER: "off" }, isPage }),
    ).toEqual({ problem: "turned off" });
    expect(
      discoverDrawingRenderer({ ...base, env: { DDL_DRAWING_RENDERER: "/nope" }, isPage }).problem,
    ).toMatch(/no render page/);
  });
});

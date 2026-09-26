// @vitest-environment happy-dom
import type { SurfaceFrame } from "@ddl/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesContext } from "../../app/services";
import { applySurfaceFrame, useSurfaceStore } from "../../state/surface-store";
import { BrowserView } from "./BrowserView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frame: SurfaceFrame = {
  threadId: "thr_1",
  surface: "browser",
  mimeType: "image/jpeg",
  data: "AAAA",
  width: 1280,
  height: 800,
  url: "https://guide.example/robot-vacuums",
  title: "Robot vacuums compared",
  ts: Date.now(),
  action: { kind: "click", x: 640, y: 400, text: "Place order" },
};

describe("BrowserView", () => {
  let container: HTMLDivElement;
  let root: Root;
  const send = vi.fn();

  beforeEach(() => {
    useSurfaceStore.setState({ frames: {}, actions: {} });
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() =>
      root.render(
        <ServicesContext value={{ client: { send } } as unknown as Services}>
          <BrowserView threadId="thr_1" />
        </ServicesContext>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    send.mockReset();
  });

  it("subscribes to the thread's browser and shows its frames as they arrive", () => {
    expect(send).toHaveBeenCalledWith({
      type: "surface.subscribe",
      threadId: "thr_1",
      surface: "browser",
    });
    expect(container.textContent).toContain("Waiting for the browser…");

    act(() => applySurfaceFrame(frame));
    const img = container.querySelector<HTMLImageElement>('[data-testid="browser-frame"]');
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(container.querySelector('[data-testid="browser-url"]')?.textContent).toBe(frame.url);
    expect(container.querySelector(".browser-title")?.textContent).toBe(frame.title);
    expect(container.querySelector('[data-testid="action-marker"]')?.textContent).toBe(
      "Place order",
    );
  });
});

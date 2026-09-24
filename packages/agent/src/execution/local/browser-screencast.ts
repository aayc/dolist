import type { Logger } from "@ddl/core";
import type { CDPSession, Page } from "playwright-core";
import { jpegSizeFromBase64 } from "../util/jpeg";

export interface ScreencastOptions {
  quality: number;
  maxWidth: number;
  maxHeight: number;
  /** Frames are acked no sooner than this after arrival, which caps the frame rate. */
  minFrameIntervalMs: number;
}

export const DEFAULT_SCREENCAST: ScreencastOptions = {
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  minFrameIntervalMs: 100,
};

export interface ScreencastFrame {
  data: string;
  width: number;
  height: number;
}

/** CDP `Page.startScreencast` on one page. Chrome only paints (and sends) frames when content changes. */
export class Screencast {
  readonly page: Page;
  private readonly cdp: CDPSession;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  private constructor(page: Page, cdp: CDPSession) {
    this.page = page;
    this.cdp = cdp;
  }

  static async start(
    page: Page,
    onFrame: (frame: ScreencastFrame) => void,
    options: ScreencastOptions,
    logger: Logger,
  ): Promise<Screencast> {
    const cdp = await page.context().newCDPSession(page);
    const screencast = new Screencast(page, cdp);
    cdp.on("Page.screencastFrame", (event) => {
      if (screencast.stopped) return;
      const size = jpegSizeFromBase64(event.data) ?? {
        width: Math.round(event.metadata.deviceWidth),
        height: Math.round(event.metadata.deviceHeight),
      };
      try {
        onFrame({ data: event.data, ...size });
      } catch (error) {
        logger.warn("screencast frame handler failed", { error: String(error) });
      }
      // Chrome keeps at most one unacked frame in flight, so a delayed ack throttles the stream.
      const timer = setTimeout(() => {
        screencast.timers.delete(timer);
        if (screencast.stopped) return;
        cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      }, options.minFrameIntervalMs);
      screencast.timers.add(timer);
    });
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: options.quality,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        everyNthFrame: 1,
      });
    } catch (error) {
      await screencast.stop();
      throw error;
    }
    return screencast;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
  }
}

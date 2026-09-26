import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, type Logger, silentLogger, sleep, type Unsubscribe } from "@ddl/core";
import { ComputerPermissionError, ComputerUnavailableError, ExecutionError } from "../errors";
import type {
  ComputerController,
  ComputerPermissions,
  ComputerScreenshot,
  FrameListener,
} from "../types";
import { type FrameAction, FrameHub } from "../util/frame-hub";
import { jpegSize } from "../util/jpeg";
import { Mutex } from "../util/mutex";
import {
  computeScale,
  type Point,
  type ScreenshotGeometry,
  scrollSteps,
  toImagePixel,
  toScreenPoint,
} from "./computer-geometry";
import { formatKeyCombo, keyComboEvents, parseKeyCombo, typingSteps } from "./computer-keys";
import { type ComputerPermission, permissionHelp } from "./computer-permissions";
import {
  ACCESSIBILITY_DENIED,
  type CommandRunner,
  execFileRunner,
  INPUT_SCRIPT,
  PERMISSIONS_SCRIPT,
  runJxa,
  SCREEN_SIZE_SCRIPT,
} from "./jxa";

export { permissionHelp } from "./computer-permissions";

export const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;
const MAX_TYPE_CHARS = 10_000;
const JPEG_QUALITY = "70";

export interface MacComputerOptions {
  logger?: Logger;
  /** Default screenshot width in pixels (images are downscaled to fit). */
  maxWidth?: number;
  /** Pause between an action and the frame captured after it, so the UI has reacted. */
  settleMs?: number;
  runner?: CommandRunner;
  tmpDir?: string;
  /** Name of the app that holds the permissions, for help texts. */
  hostName?: () => Promise<string | undefined>;
}

/**
 * Drives this Mac's desktop: `screencapture` + `sips` for screenshots, CoreGraphics events (via
 * JXA) for input. Model coordinates are pixels of the most recent screenshot; they are mapped to
 * screen points with that screenshot's scale.
 */
export class MacComputerController implements ComputerController {
  readonly platform = "macos" as const;
  private readonly logger: Logger;
  private readonly maxWidth: number;
  private readonly settleMs: number;
  private readonly runner: CommandRunner;
  private readonly tmpDir: string;
  private readonly mutex = new Mutex();
  private readonly frames: FrameHub;
  private readonly hostName: () => Promise<string | undefined>;
  private last: ScreenshotGeometry | undefined;

  constructor(options: MacComputerOptions = {}) {
    this.logger = (options.logger ?? silentLogger).child({ component: "computer" });
    this.maxWidth = options.maxWidth ?? DEFAULT_SCREENSHOT_MAX_WIDTH;
    this.settleMs = options.settleMs ?? 300;
    this.runner = options.runner ?? execFileRunner;
    this.tmpDir = options.tmpDir ?? tmpdir();
    this.hostName = options.hostName ?? (async () => undefined);
    this.frames = new FrameHub({ logger: this.logger });
  }

  async check(): Promise<{ ok: boolean; problem?: string }> {
    let status: { accessibility?: unknown; screenRecording?: unknown };
    try {
      status = JSON.parse(await runJxa(this.runner, PERMISSIONS_SCRIPT));
    } catch (error) {
      return { ok: false, problem: `Could not query macOS permissions: ${errorMessage(error)}` };
    }
    const screenOk =
      typeof status.screenRecording === "boolean"
        ? status.screenRecording
        : await this.canCapture();
    const missing: ComputerPermission[] = [];
    if (status.accessibility !== true) missing.push("accessibility");
    if (!screenOk) missing.push("screen");
    return missing.length === 0
      ? { ok: true }
      : { ok: false, problem: permissionHelp(missing, await this.host()) };
  }

  /** Never prompts and never captures: an unknown Screen Recording status counts as missing. */
  async permissions(): Promise<ComputerPermissions> {
    const status: { accessibility?: unknown; screenRecording?: unknown } = JSON.parse(
      await runJxa(this.runner, PERMISSIONS_SCRIPT),
    );
    return {
      accessibility: status.accessibility === true,
      screenRecording: status.screenRecording === true,
    };
  }

  screenshot(options: { maxWidth?: number } = {}): Promise<ComputerScreenshot> {
    return this.mutex.run(() =>
      this.capture(options.maxWidth ?? this.maxWidth, () => ({ kind: "screenshot" })),
    );
  }

  click(
    x: number,
    y: number,
    options: { button?: "left" | "right"; double?: boolean } = {},
  ): Promise<void> {
    return this.mutex.run(async () => {
      const point = this.toPoint(x, y);
      const button = options.button ?? "left";
      await this.input({ op: "click", ...point, button, clicks: options.double ? 2 : 1 });
      const kind = options.double ? "double_click" : button === "right" ? "right_click" : "click";
      await this.afterAction(kind, point);
    });
  }

  move(x: number, y: number): Promise<void> {
    return this.mutex.run(async () => {
      const point = this.toPoint(x, y);
      await this.input({ op: "move", ...point });
      await this.afterAction("move", point);
    });
  }

  type(text: string): Promise<void> {
    return this.mutex.run(async () => {
      if (text.length > MAX_TYPE_CHARS) {
        throw new ExecutionError(
          `Text is too long to type (${text.length} > ${MAX_TYPE_CHARS} characters).`,
        );
      }
      const steps = typingSteps(text);
      await this.input({ op: "type", steps }, 15_000 + steps.length * 40);
      await this.afterAction("type", undefined, text.length > 60 ? `${text.slice(0, 60)}…` : text);
    });
  }

  key(combo: string): Promise<void> {
    return this.mutex.run(async () => {
      let parsed: ReturnType<typeof parseKeyCombo>;
      try {
        parsed = parseKeyCombo(combo);
      } catch (error) {
        throw new ExecutionError(errorMessage(error), { cause: error });
      }
      await this.input({ op: "keys", events: keyComboEvents(parsed) });
      await this.afterAction("key", undefined, formatKeyCombo(parsed));
    });
  }

  scroll(dx: number, dy: number): Promise<void> {
    return this.mutex.run(async () => {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        throw new ExecutionError(`Scroll amounts must be numbers, got (${dx}, ${dy}).`);
      }
      const steps = scrollSteps(dx, dy);
      if (steps.length > 0) await this.input({ op: "scroll", steps });
      await this.afterAction("scroll", undefined, `${dx},${dy}`);
    });
  }

  onFrame(listener: FrameListener): Unsubscribe {
    return this.frames.subscribe(listener);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private toPoint(x: number, y: number): Point {
    if (!this.last) {
      throw new ExecutionError(
        "Take a computer_screenshot first: coordinates are pixels of the most recent screenshot.",
      );
    }
    return toScreenPoint(x, y, this.last);
  }

  private async input(args: Record<string, unknown>, timeoutMs = 15_000): Promise<void> {
    try {
      await runJxa(this.runner, INPUT_SCRIPT, args, timeoutMs);
    } catch (error) {
      const detail = `${errorMessage(error)} ${(error as { stderr?: unknown }).stderr ?? ""}`;
      if (detail.includes(ACCESSIBILITY_DENIED)) {
        throw new ComputerPermissionError(permissionHelp(["accessibility"], await this.host()), {
          cause: error,
        });
      }
      throw new ExecutionError(`Desktop input failed: ${errorMessage(error)}`, { cause: error });
    }
    this.logger.debug("desktop input", { op: args.op });
  }

  /** Captures a frame showing the action's result, only when someone is watching. */
  private async afterAction(kind: string, point?: Point, text?: string): Promise<void> {
    if (this.frames.size === 0) return;
    await sleep(this.settleMs);
    try {
      await this.capture(this.maxWidth, (geometry) => ({
        kind,
        ...(point ? toImagePixel(point, geometry) : {}),
        ...(text === undefined ? {} : { text }),
      }));
    } catch (error) {
      this.logger.debug("post-action capture failed", { error: errorMessage(error) });
    }
  }

  /** Takes a screenshot, makes it the coordinate reference and shows it to frame listeners. */
  private async capture(
    maxWidth: number,
    action: (geometry: ScreenshotGeometry) => FrameAction,
  ): Promise<ComputerScreenshot> {
    const shot = await this.grab(maxWidth);
    this.last = { width: shot.width, height: shot.height, scale: shot.scale };
    this.frames.emit({
      mimeType: shot.mimeType,
      data: shot.data,
      width: shot.width,
      height: shot.height,
      action: action(this.last),
      ts: Date.now(),
    });
    return shot;
  }

  private async grab(maxWidth: number): Promise<ComputerScreenshot> {
    const dir = await mkdtemp(join(this.tmpDir, "ddl-screen-"));
    try {
      const raw = join(dir, "raw.jpg");
      const [, screen] = await Promise.all([
        this.runner("screencapture", ["-x", "-m", "-C", "-t", "jpg", raw]).catch(
          async (error: unknown) => {
            throw new ComputerPermissionError(
              `Screenshot failed (${errorMessage(error)}).\n${permissionHelp(["screen"], await this.host())}`,
              { cause: error },
            );
          },
        ),
        this.screenSize(),
      ]);
      let bytes = await readFile(raw);
      let size = jpegSize(bytes);
      if (size && Math.max(size.width, size.height) > maxWidth) {
        const scaled = join(dir, "scaled.jpg");
        await this.runner("sips", [
          "-Z",
          String(maxWidth),
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          JPEG_QUALITY,
          raw,
          "--out",
          scaled,
        ]);
        bytes = await readFile(scaled);
        size = jpegSize(bytes);
      }
      if (!size) throw new ExecutionError("The screenshot could not be read.");
      return {
        data: bytes.toString("base64"),
        mimeType: "image/jpeg",
        width: size.width,
        height: size.height,
        scale: computeScale(size.width, screen.width),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async screenSize(): Promise<{ width: number; height: number }> {
    const parsed: unknown = JSON.parse(await runJxa(this.runner, SCREEN_SIZE_SCRIPT));
    const { width, height } = (parsed ?? {}) as { width?: unknown; height?: unknown };
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
      throw new ExecutionError("Could not determine the screen size.");
    }
    return { width, height };
  }

  private async canCapture(): Promise<boolean> {
    try {
      await this.grab(320);
      return true;
    } catch {
      return false;
    }
  }

  private async host(): Promise<string | undefined> {
    try {
      return await this.hostName();
    } catch {
      return undefined;
    }
  }
}

/** Stand-in on platforms without computer use: `check()` explains, everything else throws. */
export class UnsupportedComputerController implements ComputerController {
  readonly platform = "unsupported" as const;
  private readonly reason: string;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.reason = `Computer use is only available on macOS (this machine runs ${platform}).`;
  }

  async check(): Promise<{ ok: boolean; problem?: string }> {
    return { ok: false, problem: this.reason };
  }

  async permissions(): Promise<ComputerPermissions> {
    return { accessibility: false, screenRecording: false };
  }

  screenshot(): Promise<ComputerScreenshot> {
    return Promise.reject(new ComputerUnavailableError(this.reason));
  }

  click(): Promise<void> {
    return Promise.reject(new ComputerUnavailableError(this.reason));
  }

  move(): Promise<void> {
    return Promise.reject(new ComputerUnavailableError(this.reason));
  }

  type(): Promise<void> {
    return Promise.reject(new ComputerUnavailableError(this.reason));
  }

  key(): Promise<void> {
    return Promise.reject(new ComputerUnavailableError(this.reason));
  }

  scroll(): Promise<void> {
    return Promise.reject(new ComputerUnavailableError(this.reason));
  }

  onFrame(): Unsubscribe {
    return () => {};
  }
}

export function createComputerController(
  options: MacComputerOptions & { platform?: NodeJS.Platform } = {},
): ComputerController {
  const platform = options.platform ?? process.platform;
  return platform === "darwin"
    ? new MacComputerController(options)
    : new UnsupportedComputerController(platform);
}

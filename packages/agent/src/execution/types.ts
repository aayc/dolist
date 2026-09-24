/**
 * Execution Providers supply the agent's "hands": a shell, a browser and (on macOS) the desktop.
 * The agent loop itself always runs in the daemon; only effects are delegated. `local` uses this
 * machine; `cloud` (not implemented yet) will proxy the same interfaces to a remote sandbox/VM.
 */
import type { SurfaceFrame, ToolSpec, Unsubscribe } from "@ddl/core";

export interface ShellExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streamed combined output chunks (UTF-8). */
  onData?: (chunk: string) => void;
  /** Output beyond this is truncated (head+tail kept). Default 200 KB. */
  maxOutputBytes?: number;
}

export interface ShellResult {
  exitCode: number | null;
  /** Combined stdout+stderr in arrival order. */
  output: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ShellExecutor {
  exec(command: string, options: ShellExecOptions): Promise<ShellResult>;
}

export type FrameListener = (frame: Omit<SurfaceFrame, "threadId" | "surface">) => void;

export interface BrowserSnapshot {
  url: string;
  title: string;
  /** Accessibility-tree snapshot; interactive elements carry `[ref=eN]` markers usable as targets. */
  snapshot: string;
}

/** Element target: prefer `ref` from the latest snapshot; `selector`/`text` are fallbacks. */
export interface BrowserTarget {
  ref?: string;
  selector?: string;
  text?: string;
}

export interface Screenshot {
  /** Base64 image bytes. */
  data: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export interface BrowserSession {
  readonly key: string;
  navigate(url: string): Promise<BrowserSnapshot>;
  snapshot(): Promise<BrowserSnapshot>;
  click(target: BrowserTarget): Promise<BrowserSnapshot>;
  type(
    target: BrowserTarget,
    text: string,
    options?: { submit?: boolean; clear?: boolean },
  ): Promise<BrowserSnapshot>;
  selectOption(target: BrowserTarget, values: string[]): Promise<BrowserSnapshot>;
  press(key: string): Promise<BrowserSnapshot>;
  scroll(direction: "up" | "down", pixels?: number): Promise<BrowserSnapshot>;
  back(): Promise<BrowserSnapshot>;
  screenshot(options?: { fullPage?: boolean }): Promise<Screenshot>;
  /** Readable page text (article-ish extraction), capped at `maxChars`. */
  extractText(options?: { maxChars?: number }): Promise<string>;
  /** Live frames for the UI's browser view (screencast). Start lazily on first listener. */
  onFrame(listener: FrameListener): Unsubscribe;
  close(): Promise<void>;
}

export interface BrowserController {
  /** Returns the session for `key` (a thread id), creating it on first use. */
  session(key: string): Promise<BrowserSession>;
  has(key: string): boolean;
  close(key: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface ComputerScreenshot extends Screenshot {
  /** Screenshot pixels per screen point (for mapping model coordinates back to the screen). */
  scale: number;
}

export interface ComputerController {
  readonly platform: "macos" | "unsupported";
  /** Checks OS permissions (Screen Recording, Accessibility). */
  check(): Promise<{ ok: boolean; problem?: string }>;
  /** Coordinates everywhere are in screenshot pixel space of the most recent screenshot. */
  screenshot(options?: { maxWidth?: number }): Promise<ComputerScreenshot>;
  click(
    x: number,
    y: number,
    options?: { button?: "left" | "right"; double?: boolean },
  ): Promise<void>;
  move(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  /** Key combo like `cmd+shift+4`, `enter`, `escape`. */
  key(combo: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  onFrame(listener: FrameListener): Unsubscribe;
}

export interface Workspace {
  key: string;
  /** Absolute scratch directory for this task (files the agent creates live here). */
  dir: string;
}

export interface ExecutionCapabilities {
  shell: boolean;
  browser: boolean;
  computer: boolean;
}

/** Capabilities a subagent can be granted by the orchestrator. */
export type Capability = "web" | "browser" | "computer" | "shell" | "files" | "connectors";

export interface ExecutionProvider {
  readonly id: string;
  readonly capabilities: ExecutionCapabilities;
  readonly shell: ShellExecutor;
  readonly browser?: BrowserController;
  readonly computer?: ComputerController;
  prepareWorkspace(key: string): Promise<Workspace>;
  dispose(): Promise<void>;
}

export interface ExecutionToolContext {
  threadId: string;
  taskId: string | null;
  workspace: Workspace;
  capabilities: Capability[];
  /** Forward live frames to the thread's UI surfaces. */
  onFrame?: (surface: "browser" | "computer", frame: Parameters<FrameListener>[0]) => void;
}

/** Builds the model-facing tools (browser_*, computer_*, shell) for one subagent. */
export type ExecutionToolFactory = (
  provider: ExecutionProvider,
  ctx: ExecutionToolContext,
) => ToolSpec[];

export type ExecutionConfig =
  | {
      kind: "local";
      /** DDL_HOME: workspaces and the agent browser profile live under here. */
      home: string;
      browser?: {
        /** Default true: frames are streamed into the thread's browser view. */
        headless?: boolean;
        /** Default "chrome" (the installed Google Chrome); falls back to Playwright chromium. */
        channel?: "chrome" | "chromium" | "msedge";
        executablePath?: string;
      };
      computer?: { enabled: boolean };
    }
  | {
      kind: "cloud";
      endpoint: string;
      /** Name of the env var holding the API key (never the key itself). */
      apiKeyEnv: string;
    };

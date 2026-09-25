/**
 * Execution Providers supply the agent's "hands": a shell, a browser and (on macOS) the desktop.
 * The agent loop itself always runs in the daemon; only effects are delegated. `local` uses this
 * machine; `cloud` (not implemented yet) will proxy the same interfaces to a remote sandbox/VM.
 */
import type { ComputerAccess, SurfaceFrame, SurfaceKind, ToolSpec, Unsubscribe } from "@ddl/core";

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
  /** Events since the previous snapshot the model should know about (dialogs, new tabs, downloads). */
  notes?: string[];
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

export interface ComputerPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface ComputerController {
  readonly platform: "macos" | "unsupported";
  /** Checks OS permissions (Screen Recording, Accessibility). */
  check(): Promise<{ ok: boolean; problem?: string }>;
  /** Permission status without prompting and without capturing the screen. */
  permissions?(): Promise<ComputerPermissions>;
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

// ── App control: one app at a time, in the background, through its accessibility tree ──────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A running app. `name` and `bundleId` come from the app itself, never from the model. */
export interface AppRef {
  name: string;
  bundleId?: string;
  pid: number;
}

export interface RunningApp extends AppRef {
  active: boolean;
  hidden: boolean;
}

export interface InstalledApp {
  name: string;
  bundleId?: string;
  path: string;
}

export interface ResolvedApp extends AppRef {
  /** It wasn't running and was launched (without activating it). */
  launched: boolean;
}

export interface AppWindow {
  title: string;
  /** Global screen points. */
  frame: Rect;
}

/** One element of an app snapshot; `id` is valid within that snapshot only. */
export interface AppElement {
  id: string;
  role: string;
  subrole?: string;
  name?: string;
  value?: string;
  settable: boolean;
  actions: string[];
  frame?: Rect;
  enabled: boolean;
  focused: boolean;
}

export interface AppSnapshot {
  snapshotId: string;
  app: AppRef;
  window: AppWindow | null;
  /** One element per line, indented by depth: `[e12] AXButton name="Send" actions=press`. */
  text: string;
  elements: AppElement[];
  truncated: boolean;
}

export interface AppScreenshot extends Screenshot {
  /** Image pixels per screen point. */
  scale: number;
  /** Screen point of the image's top-left corner. */
  origin: { x: number; y: number };
  app?: AppRef;
  window?: AppWindow;
}

/** What an action did to the app's latest snapshot. */
export interface AppActionOutcome {
  /** The UI may have changed: element ids of the latest snapshot are no longer valid. */
  stale: boolean;
}

/** Accessibility actions an element can perform (`press` is AXPress). */
export type PressAction =
  | "press"
  | "show-menu"
  | "confirm"
  | "cancel"
  | "increment"
  | "decrement"
  | "raise"
  | "pick"
  | "scroll-to-visible";

/** An element of an app's latest snapshot. */
export interface AppElementTarget {
  snapshotId: string;
  elementId: string;
}

/**
 * Operates native apps without bringing them forward or moving the real cursor (macOS: the
 * `ddl-computer` helper). Refuses protected apps (Daily Do List, System Settings, password
 * managers, authenticators) whatever the caller asks.
 */
export interface AppController {
  /** False once the helper can't be used at all (missing, incompatible, shut down). */
  readonly available: boolean;
  permissions(): Promise<ComputerPermissions>;
  /** Regular apps that are running, frontmost first. */
  runningApps(): Promise<RunningApp[]>;
  /** Apps installed in the usual folders, sorted by name (cached). */
  installedApps(): Promise<InstalledApp[]>;
  /** Finds the app, launching it in the background when it isn't running. */
  openApp(target: { name: string } | { bundleId: string }): Promise<ResolvedApp>;
  /** The app's focused window; with `expand`, that element's omitted subtree joins its snapshot. */
  snapshot(
    pid: number,
    options?: { expand?: AppElementTarget; maxNodes?: number },
  ): Promise<AppSnapshot>;
  /** The app's window (even when covered), or the main display without `pid`. */
  screenshot(pid?: number, options?: { maxWidth?: number }): Promise<AppScreenshot>;
  press(pid: number, target: AppElementTarget, action?: PressAction): Promise<AppActionOutcome>;
  setValue(
    pid: number,
    target: AppElementTarget,
    value: string,
  ): Promise<AppActionOutcome & { value?: string }>;
  /** Types into the app (into `target`, focused first, when given). Line breaks press Return. */
  typeText(pid: number, text: string, target?: AppElementTarget): Promise<AppActionOutcome>;
  key(pid: number, combo: string): Promise<AppActionOutcome>;
  /** `point` in global screen points; it must be inside one of the app's windows. */
  click(
    pid: number,
    point: { x: number; y: number },
    options?: { button?: "left" | "right"; count?: number },
  ): Promise<AppActionOutcome>;
  scroll(pid: number, point: { x: number; y: number }, dx: number, dy: number): Promise<void>;
  dispose(): Promise<void>;
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
  /** App control; absent without the helper (computer use is then screen-level only). */
  readonly apps?: AppController;
  /** Computer use permissions and app control; undefined where computer use doesn't exist. */
  computerAccess?(): Promise<ComputerAccess | undefined>;
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
  /** Someone is watching the surface (frames nobody sees aren't captured). Default: yes. */
  watching?: (surface: SurfaceKind) => boolean;
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
      computer?: {
        enabled: boolean;
        /** The `ddl-computer` helper binary; without it computer use stays screen-level. */
        helper?: string;
      };
    }
  | {
      kind: "cloud";
      endpoint: string;
      /** Name of the env var holding the API key (never the key itself). */
      apiKeyEnv: string;
    };

/**
 * The `ddl-computer serve` RPC: one JSON request per line on stdin, one response per line on
 * stdout, matched by id. Results carry other apps' UI content, so every one is parsed defensively
 * here (types checked, strings and lists bounded) before anything else sees it.
 */
import { ExecutionError } from "../../errors";
import type {
  AppActionOutcome,
  AppElement,
  AppRef,
  AppScreenshot,
  AppSnapshot,
  AppWindow,
  ComputerPermissions,
  InstalledApp,
  Rect,
  ResolvedApp,
  RunningApp,
} from "../../types";

export const HELPER_PROTOCOL_VERSION = 1;

export const HELPER_ERROR_CODES = [
  "permission",
  "not_found",
  "stale",
  "protected",
  "unsupported",
  "invalid",
  "failed",
] as const;
export type HelperErrorCode = (typeof HELPER_ERROR_CODES)[number];

export type HelperMethod =
  | "hello"
  | "permissions"
  | "apps"
  | "installedApps"
  | "resolveApp"
  | "activate"
  | "snapshot"
  | "screenshot"
  | "press"
  | "setValue"
  | "typeText"
  | "key"
  | "click"
  | "scroll";

/** A well-formed error response from the helper. */
export class HelperError extends ExecutionError {
  override name = "HelperError";
  readonly code: HelperErrorCode;
  readonly method: HelperMethod;

  constructor(code: HelperErrorCode, message: string, method: HelperMethod) {
    super(message);
    this.code = code;
    this.method = method;
  }
}

/** The helper answered something that isn't the protocol. */
export class HelperProtocolError extends ExecutionError {
  override name = "HelperProtocolError";
}

const MAX_NAME = 200;
const MAX_VALUE = 1_000;
const MAX_TEXT = 200_000;
const MAX_ELEMENTS = 5_000;
const MAX_APPS = 2_000;
const MAX_IMAGE_BASE64 = 30 * 1024 * 1024;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(what: string): never {
  throw new HelperProtocolError(`The computer helper sent a malformed ${what}.`);
}

function record(value: unknown, what: string): Json {
  return isRecord(value) ? value : fail(what);
}

function text(value: unknown, what: string, max = MAX_NAME): string {
  return typeof value === "string" ? value.slice(0, max) : fail(what);
}

function optionalText(value: unknown, max = MAX_NAME): string | undefined {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : undefined;
}

function finite(value: unknown, what: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(what);
}

function flag(value: unknown): boolean {
  return value === true;
}

function pid(value: unknown, what: string): number {
  const n = finite(value, what);
  return Number.isInteger(n) && n > 0 ? n : fail(what);
}

function rect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : undefined;
}

function list(value: unknown, what: string, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : fail(what);
}

function appRef(value: unknown, what: string): AppRef {
  const app = record(value, what);
  const bundleId = optionalText(app.bundleId);
  return {
    name: text(app.name, `${what} name`),
    ...(bundleId ? { bundleId } : {}),
    pid: pid(app.pid, `${what} pid`),
  };
}

function appWindow(value: unknown): AppWindow | null {
  if (!isRecord(value)) return null;
  const frame = rect(value.frame);
  return frame ? { title: optionalText(value.title) ?? "", frame } : null;
}

export function parseHello(value: unknown): { version: number; pid: number } {
  const hello = record(value, "hello");
  return { version: finite(hello.version, "hello version"), pid: pid(hello.pid, "hello pid") };
}

export function parsePermissions(value: unknown): ComputerPermissions {
  const permissions = record(value, "permission status");
  return {
    accessibility: flag(permissions.accessibility),
    screenRecording: flag(permissions.screenRecording),
  };
}

export function parseRunningApps(value: unknown): RunningApp[] {
  const apps = list(record(value, "app list").apps, "app list", MAX_APPS);
  return apps.map((entry) => {
    const app = record(entry, "app");
    return { ...appRef(app, "app"), active: flag(app.active), hidden: flag(app.hidden) };
  });
}

export function parseInstalledApps(value: unknown): InstalledApp[] {
  const apps = list(record(value, "installed app list").apps, "installed app list", MAX_APPS);
  return apps.map((entry) => {
    const app = record(entry, "installed app");
    const bundleId = optionalText(app.bundleId);
    return {
      name: text(app.name, "installed app name"),
      ...(bundleId ? { bundleId } : {}),
      path: text(app.path, "installed app path", 1_000),
    };
  });
}

export function parseResolvedApp(value: unknown): ResolvedApp {
  const app = record(value, "resolved app");
  return { ...appRef(app, "resolved app"), launched: flag(app.launched) };
}

function element(value: unknown): AppElement {
  const el = record(value, "element");
  const subrole = optionalText(el.subrole);
  const name = optionalText(el.name);
  const elementValue = optionalText(el.value, MAX_VALUE);
  const frame = rect(el.frame);
  const actions = Array.isArray(el.actions)
    ? el.actions.filter((a): a is string => typeof a === "string").slice(0, 20)
    : [];
  return {
    id: text(el.id, "element id", 40),
    role: text(el.role, "element role", 80),
    ...(subrole ? { subrole } : {}),
    ...(name ? { name } : {}),
    ...(elementValue ? { value: elementValue } : {}),
    settable: flag(el.settable),
    actions,
    ...(frame ? { frame } : {}),
    enabled: el.enabled !== false,
    focused: flag(el.focused),
  };
}

export function parseSnapshot(value: unknown): AppSnapshot {
  const snap = record(value, "snapshot");
  return {
    snapshotId: text(snap.snapshotId, "snapshot id", 100),
    app: appRef(snap.app, "snapshot app"),
    window: appWindow(snap.window),
    text: text(snap.text, "snapshot text", MAX_TEXT),
    elements: list(snap.elements, "snapshot elements", MAX_ELEMENTS).map(element),
    truncated: flag(snap.truncated),
  };
}

export function parseScreenshot(value: unknown): AppScreenshot {
  const shot = record(value, "screenshot");
  const mimeType = shot.mimeType === "image/png" ? "image/png" : "image/jpeg";
  const width = finite(shot.width, "screenshot width");
  const height = finite(shot.height, "screenshot height");
  const scale = finite(shot.scale, "screenshot scale");
  if (!(width > 0 && height > 0 && scale > 0)) fail("screenshot size");
  const origin = record(shot.origin, "screenshot origin");
  const window = appWindow(shot.window);
  return {
    data: text(shot.image, "screenshot image", MAX_IMAGE_BASE64),
    mimeType,
    width,
    height,
    scale,
    origin: { x: finite(origin.x, "screenshot origin"), y: finite(origin.y, "screenshot origin") },
    ...(isRecord(shot.app) ? { app: appRef(shot.app, "screenshot app") } : {}),
    ...(window ? { window } : {}),
  };
}

export function parseOutcome(value: unknown): AppActionOutcome {
  return { stale: flag(record(value, "action result").stale) };
}

export function parseSetValue(value: unknown): AppActionOutcome & { value?: string } {
  const result = record(value, "set value result");
  const readBack = typeof result.value === "string" ? result.value.slice(0, MAX_VALUE) : undefined;
  return { stale: flag(result.stale), ...(readBack === undefined ? {} : { value: readBack }) };
}

/** A response line: `{ id, result }` or `{ id, error: { code, message } }`; null if it isn't one. */
export function parseResponse(
  line: string,
):
  | { id: number; result: unknown }
  | { id: number; error: { code: HelperErrorCode; message: string } }
  | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.id !== "number" || !Number.isSafeInteger(raw.id)) return null;
  const error = raw.error;
  if (isRecord(error)) {
    const code = HELPER_ERROR_CODES.find((c) => c === error.code) ?? "failed";
    const message =
      typeof error.message === "string" && error.message.trim()
        ? error.message.trim().slice(0, 500)
        : `The computer helper failed (${code}).`;
    return { id: raw.id, error: { code, message } };
  }
  return "result" in raw ? { id: raw.id, result: raw.result } : null;
}

import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. Injectable so the macOS controller can be tested anywhere. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;

export class CommandError extends Error {
  override name = "CommandError";
  readonly stderr: string;

  constructor(message: string, stderr: string, options?: ErrorOptions) {
    super(message, options);
    this.stderr = stderr;
  }
}

export const execFileRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim().split("\n")[0] || error.message;
        reject(new CommandError(`${file} failed: ${detail}`, stderr, { cause: error }));
      },
    );
  });

/**
 * Encodes arguments for a JXA `run(argv)` handler. Data travels as one argv string and is
 * `JSON.parse`d by the static script, so user text is never spliced into script source. Always an
 * object, so the argument can't be mistaken for an osascript option.
 */
export function encodeJxaArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  if (typeof json !== "string" || !json.startsWith("{")) {
    throw new TypeError("JXA arguments must be a JSON-serializable object");
  }
  return json;
}

export async function runJxa(
  runner: CommandRunner,
  script: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<string> {
  const { stdout } = await runner(
    "osascript",
    ["-l", "JavaScript", "-e", script, encodeJxaArgs(args)],
    {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  );
  return stdout.trim();
}

/** Marker thrown by the input script when the host app lacks the Accessibility permission. */
export const ACCESSIBILITY_DENIED = "DDL_ACCESSIBILITY_DENIED";

/**
 * Posts synthesized input through CoreGraphics. Constants are the stable CGEventType/CGMouseButton
 * values (the JXA bridge doesn't reliably expose every enum). `CGEventCreateScrollWheelEvent2` is
 * used because the variadic original corrupts arguments on arm64, and the unicode setter is rebound
 * to take a raw UTF-16 buffer because the bridge won't marshal a JS string as `UniChar *`.
 */
export const INPUT_SCRIPT = `
function run(argv) {
  ObjC.import("CoreGraphics");
  ObjC.import("ApplicationServices");
  ObjC.import("Foundation");
  var args = JSON.parse(argv[0]);
  if (!$.AXIsProcessTrusted()) throw new Error("${ACCESSIBILITY_DENIED}");
  var HID_TAP = 0, CLICK_STATE = 1, MOVED = 5, LINE_UNITS = 1;
  function post(event) { $.CGEventPost(HID_TAP, event); }
  function mouse(type, button, clickState) {
    var event = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(args.x, args.y), button);
    if (clickState) $.CGEventSetIntegerValueField(event, CLICK_STATE, clickState);
    post(event);
  }
  function key(code, down, flags) {
    var event = $.CGEventCreateKeyboardEvent(null, code, down);
    $.CGEventSetFlags(event, flags);
    post(event);
  }
  switch (args.op) {
    case "move":
      mouse(MOVED, 0, 0);
      break;
    case "click": {
      var right = args.button === "right";
      mouse(MOVED, 0, 0);
      delay(0.05);
      for (var i = 1; i <= args.clicks; i++) {
        mouse(right ? 3 : 1, right ? 1 : 0, i);
        mouse(right ? 4 : 2, right ? 1 : 0, i);
        if (i < args.clicks) delay(0.05);
      }
      break;
    }
    case "scroll":
      for (var s = 0; s < args.steps.length; s++) {
        post($.CGEventCreateScrollWheelEvent2(null, LINE_UNITS, 2, args.steps[s].dy, args.steps[s].dx, 0));
        delay(0.02);
      }
      break;
    case "keys":
      for (var k = 0; k < args.events.length; k++) {
        key(args.events[k].code, args.events[k].down, args.events[k].flags);
        delay(0.01);
      }
      break;
    case "type": {
      ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);
      for (var t = 0; t < args.steps.length; t++) {
        var step = args.steps[t];
        if (typeof step.text === "string") {
          var utf16 = $.NSString.alloc.initWithString(step.text).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
          for (var d = 0; d < 2; d++) {
            var event = $.CGEventCreateKeyboardEvent(null, 0, d === 0);
            $.CGEventSetFlags(event, 0);
            $.CGEventKeyboardSetUnicodeString(event, utf16.length / 2, utf16.bytes);
            post(event);
          }
        } else {
          key(step.code, true, 0);
          key(step.code, false, 0);
        }
        delay(0.01);
      }
      break;
    }
    default:
      throw new Error("DDL_UNKNOWN_OP");
  }
  return "ok";
}`;

/** Size of the main display (the one `screencapture -m` captures) in global points. */
export const SCREEN_SIZE_SCRIPT = `
function run() {
  ObjC.import("CoreGraphics");
  var bounds = $.CGDisplayBounds($.CGMainDisplayID());
  return JSON.stringify({ width: bounds.size.width, height: bounds.size.height });
}`;

/** Permission status without triggering system prompts. `screenRecording` is null when unknown. */
export const PERMISSIONS_SCRIPT = `
function run() {
  ObjC.import("CoreGraphics");
  ObjC.import("ApplicationServices");
  var screenRecording = null;
  try {
    ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
    screenRecording = $.CGPreflightScreenCaptureAccess();
  } catch (error) {}
  return JSON.stringify({ accessibility: $.AXIsProcessTrusted(), screenRecording: screenRecording });
}`;

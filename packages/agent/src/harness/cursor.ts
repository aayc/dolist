/**
 * CursorHarness: runs agent conversations on the Cursor CLI (`agent acp`) with the user's Cursor
 * login. Implementation lives in `./cursor/`; this is the public entry point
 * (`@ddl/agent/cursor`). Like `./pi`, it is loaded on first use, never from the package index.
 */
import { CursorHarness, type CursorHarnessOptions } from "./cursor/harness";
import type { Harness } from "./types";

export type { CursorCliCheckOptions, CursorCliStatus } from "./cursor/cli";
export {
  CURSOR_INSTALL_COMMAND,
  CURSOR_LOGIN_COMMAND,
  checkCursorCli,
  cursorCliProblem,
  findCursorCli,
} from "./cursor/cli";
export type { CursorHarnessOptions } from "./cursor/harness";

export function createCursorHarness(options: CursorHarnessOptions): Harness {
  return new CursorHarness(options);
}

/**
 * PiHarness: embeds Pi's coding-agent SDK behind our Harness interface. Implementation lives in
 * `./pi/`; this is the public entry point.
 */

import { PiHarness, type PiHarnessOptions } from "./pi/harness";
import type { Harness } from "./types";

export type { PiHarnessOptions } from "./pi/harness";

export function createPiHarness(options: PiHarnessOptions): Harness {
  return new PiHarness(options);
}

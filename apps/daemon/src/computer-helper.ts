import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPUTER_HELPER_ENV = "DDL_COMPUTER_HELPER";
const HELPER_NAME = "ddl-computer";

/** `swift build` outputs of the helper package, resolved from this module (`src/` or `dist/`). */
const DEV_BUILDS = ["release", "debug"].map((configuration) =>
  fileURLToPath(
    new URL(
      `../../macos/Packages/DailyDoListComputer/.build/${configuration}/${HELPER_NAME}`,
      import.meta.url,
    ),
  ),
);

export type ComputerHelperSource = "env" | "bundled" | "dev";

export interface ComputerHelperDiscovery {
  path?: string;
  source?: ComputerHelperSource;
  /** Why the configured helper isn't used. */
  problem?: string;
}

export interface ComputerHelperOptions {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  cwd: string;
  /** The daemon's entry script; the app bundle keeps the helper in `<its directory>/../bin/`. */
  entryScript?: string;
  isExecutable?: (path: string) => boolean;
  devBuilds?: readonly string[];
}

/**
 * The `ddl-computer` helper that lets agents operate apps in the background: `DDL_COMPUTER_HELPER`
 * (`off` disables it), else the copy the Mac app bundles next to the deployed daemon
 * (`Contents/Resources/daemon/bin/ddl-computer` for `…/daemon/dist/main.js`), else a dev build.
 * Nothing on other platforms; without one, computer use stays screen-level.
 */
export function discoverComputerHelper(options: ComputerHelperOptions): ComputerHelperDiscovery {
  if (options.platform !== "darwin") return {};
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const configured = options.env[COMPUTER_HELPER_ENV]?.trim();
  if (configured) {
    if (/^(?:off|none|false|0)$/i.test(configured)) return {};
    const path = resolve(options.cwd, configured);
    return isExecutable(path)
      ? { path, source: "env" }
      : { problem: `${COMPUTER_HELPER_ENV} is not an executable file (${configured})` };
  }
  if (options.entryScript) {
    const bundled = resolve(dirname(options.entryScript), "..", "bin", HELPER_NAME);
    if (isExecutable(bundled)) return { path: bundled, source: "bundled" };
  }
  for (const dev of options.devBuilds ?? DEV_BUILDS) {
    if (isExecutable(dev)) return { path: dev, source: "dev" };
  }
  return {};
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

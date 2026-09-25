import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DRAWING_RENDERER_ENV = "DDL_DRAWING_RENDERER";
const RENDERER_DIR = "drawing-renderer";
/** The daemon's `dist/`, resolved from this module (`src/` under tsx, or the `dist/` bundle). */
const DIST_BUILD = fileURLToPath(new URL(`../dist/${RENDERER_DIR}`, import.meta.url));

export interface DrawingRendererDiscovery {
  path?: string;
  /** Why there is none (drawings are then described in text, never rendered). */
  problem?: string;
}

export interface DrawingRendererOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  /** The daemon's entry script; the build puts the page next to it (`dist/drawing-renderer`). */
  entryScript?: string;
  /** Where else to look (default: the daemon's `dist/`, for `tsx` runs of the source). */
  builds?: readonly string[];
  isPage?: (dir: string) => boolean;
}

/**
 * The page the agent renders drawings with, built by the daemon's `build` and `dev` scripts:
 * `DDL_DRAWING_RENDERER` (`off` disables rendering), else next to the entry script, else the
 * daemon's `dist/`.
 */
export function discoverDrawingRenderer(options: DrawingRendererOptions): DrawingRendererDiscovery {
  const isPage = options.isPage ?? ((dir: string) => existsSync(join(dir, "index.html")));
  const configured = options.env[DRAWING_RENDERER_ENV]?.trim();
  if (configured) {
    if (/^(?:off|none|false|0)$/i.test(configured)) return { problem: "turned off" };
    const path = resolve(options.cwd, configured);
    return isPage(path)
      ? { path }
      : { problem: `${DRAWING_RENDERER_ENV} has no render page (index.html) at ${configured}` };
  }
  const candidates = [
    ...(options.entryScript ? [resolve(dirname(options.entryScript), RENDERER_DIR)] : []),
    ...(options.builds ?? [DIST_BUILD]),
  ];
  const path = candidates.find(isPage);
  return path
    ? { path }
    : { problem: "not built (pnpm --filter @ddl/daemon build): drawings are described in text" };
}

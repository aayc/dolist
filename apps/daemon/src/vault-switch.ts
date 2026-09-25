/**
 * Which vault this daemon opens (`GET`/`PUT /api/device/vault`). Switching writes `vaultPath` to
 * `$DDL_HOME/config.json` and restarts the daemon: it answers, shuts down gracefully and exits
 * with `RESTART_EXIT_CODE`. The Mac app's supervisor starts it again at once; a daemon started by
 * hand is started again by the user (the daemon README says how). `DDL_VAULT` fixes the vault
 * (409 `locked_by_env`).
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DeviceVaultResponse, Logger } from "@ddl/core";
import { ApiError } from "./errors";
import type { JsonObjectFile } from "./home-files";
import { displayPath, resolveUserPath } from "./home-paths";
import { isInside } from "./import/walk";

/**
 * The daemon exits with this code when it must start again to apply a change (a new vault):
 * `EX_TEMPFAIL` from sysexits(3), "try again". The Mac app's supervisor restarts it immediately.
 */
export const RESTART_EXIT_CODE = 75;

export interface VaultSwitchOptions {
  /** The vault this daemon serves. */
  vaultPath: string;
  /** `DDL_VAULT` sets it. */
  lockedByEnv: boolean;
  /** A supervisor starts the daemon again after it exits with `RESTART_EXIT_CODE`. */
  supervised: boolean;
  /** `$DDL_HOME/config.json`. */
  config: JsonObjectFile;
  /** `$DDL_HOME` (null: none): a vault can't be inside it. */
  home: string | null;
  homedir: string;
  /** Why the vault can't change right now (an import is running, the vault syncs), or null. */
  blocked?: () => string | null;
  /** Shuts the daemon down and exits with `RESTART_EXIT_CODE`; called after the answer is sent. */
  restart: (vaultPath: string) => void;
  logger: Logger;
}

export class VaultSwitch {
  readonly #options: VaultSwitchOptions;
  #restarting: string | null = null;

  constructor(options: VaultSwitchOptions) {
    this.#options = options;
  }

  response(): DeviceVaultResponse {
    return { path: this.#options.vaultPath, lockedByEnv: this.#options.lockedByEnv };
  }

  async switchTo(input: string): Promise<DeviceVaultResponse> {
    const options = this.#options;
    if (options.lockedByEnv) {
      throw new ApiError(
        409,
        "locked_by_env",
        "DDL_VAULT sets the vault this daemon opens; change it there",
      );
    }
    if (this.#restarting !== null) {
      throw new ApiError(409, "conflict", "The daemon is already restarting to open another vault");
    }
    const path = await this.#resolve(input);
    const current = await realpath(options.vaultPath).catch(() => options.vaultPath);
    if (path === current) return this.response();
    const blocked = options.blocked?.();
    if (blocked) throw new ApiError(409, "conflict", blocked);

    this.#restarting = path;
    try {
      await options.config.update((config) => {
        config.vaultPath = path;
      });
    } catch (error) {
      this.#restarting = null;
      throw error;
    }
    options.logger.info("Switching vaults; restarting", {
      vault: displayPath(path, options.homedir),
    });
    setImmediate(() => options.restart(path));
    return {
      path,
      lockedByEnv: false,
      restart: options.supervised ? "supervisor" : "manual",
    };
  }

  async #resolve(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!(trimmed === "~" || trimmed.startsWith("~/") || isAbsolute(trimmed))) {
      throw invalid("The vault must be an absolute path (or start with ~/)");
    }
    const expanded = resolveUserPath(trimmed, {
      homedir: this.#options.homedir,
      base: this.#options.homedir,
    });
    let path: string;
    try {
      path = await realpath(expanded);
    } catch {
      throw invalid(`There's no folder at ${trimmed}`);
    }
    if (!(await stat(path)).isDirectory()) throw invalid(`${trimmed} isn't a folder`);
    try {
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      throw invalid(`Daily Do List can't read and write ${trimmed}`);
    }
    const home = this.#options.home && (await realpath(this.#options.home).catch(() => null));
    if (home && (isInside(path, home) || isInside(home, path))) {
      throw invalid("A vault can't be in or hold Daily Do List's own folder");
    }
    return path;
  }
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

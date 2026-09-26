import type { ExecutionProvider } from "@ddl/agent";
import type { ComputerAccess, ComputerPermissionPane } from "@ddl/core";
import type { SystemSettingsOpener } from "./system-settings";

/** `1` turns the hooks on (the e2e harness only); nothing else does. */
export const TEST_HOOKS_ENV = "DDL_TEST_HOOKS";
/** The simulated Mac's access when the hooks are on: `missing` (neither permission) or `allowed`. */
export const TEST_COMPUTER_ENV = "DDL_TEST_COMPUTER";

const GRANT_DELAY_MS = 300;

/**
 * What the e2e tests can't get from a real daemon on any machine: computer use exists only on a Mac,
 * its permissions are the Mac's own, and opening a privacy pane opens the real System Settings.
 * With the hooks, computer access is a simulated Mac's and opening a pane allows its permission a
 * moment later, as a user would. They change nothing else: routes, the token and the loopback
 * checks stay as they are.
 */
export interface TestHooks {
  /** The provider, with the simulated Mac's computer access and no computer or app controller. */
  execution(provider: ExecutionProvider): ExecutionProvider;
  systemSettings: SystemSettingsOpener;
}

export function testHooks(
  env: Record<string, string | undefined>,
  options: { grantDelayMs?: number } = {},
): TestHooks | null {
  if (env[TEST_HOOKS_ENV]?.trim() !== "1") return null;
  const allowed = env[TEST_COMPUTER_ENV]?.trim() !== "missing";
  const access: ComputerAccess = {
    accessibility: allowed,
    screenRecording: allowed,
    appControl: true,
    hostApp: { name: "Daily Do List" },
  };
  const grant = (pane: ComputerPermissionPane) => {
    access[pane] = true;
  };
  return {
    execution: (provider) =>
      new Proxy(provider, {
        get(target, property) {
          if (property === "capabilities") return { ...target.capabilities, computer: true };
          if (property === "computerAccess") return async () => ({ ...access });
          if (property === "computer" || property === "apps") return undefined;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    systemSettings: {
      async open(pane) {
        setTimeout(() => grant(pane), options.grantDelayMs ?? GRANT_DELAY_MS);
        return "opened";
      },
    },
  };
}

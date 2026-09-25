import type { ComputerAccess, ComputerPermissionPane } from "@ddl/core";

/** `ready`: both permissions granted; `missing`: neither; `none`: no computer use at all. */
export type MockComputerMode = "ready" | "missing" | "none";

export function parseMockComputerMode(value: string | null | undefined): MockComputerMode {
  return value === "missing" || value === "none" ? value : "ready";
}

/**
 * The mock daemon's Mac. Opening a pane "in System Settings" grants that permission a moment
 * later, as if the user turned it on, so the UI's polling can be exercised end to end.
 */
export class MockComputer {
  private access: ComputerAccess | undefined;
  private readonly onChange: () => void;
  private readonly grantDelayMs: number;

  constructor(mode: MockComputerMode, onChange: () => void, grantDelayMs = 1_200) {
    this.onChange = onChange;
    this.grantDelayMs = grantDelayMs;
    this.access =
      mode === "none"
        ? undefined
        : {
            accessibility: mode === "ready",
            screenRecording: mode === "ready",
            appControl: true,
            hostApp: { name: "Daily Do List", path: "/Applications/Daily Do List.app" },
          };
  }

  status(): ComputerAccess | undefined {
    return this.access ? structuredClone(this.access) : undefined;
  }

  open(pane: ComputerPermissionPane): "opened" | "unsupported" {
    if (!this.access) return "unsupported";
    setTimeout(() => {
      if (!this.access || this.access[pane]) return;
      this.access = { ...this.access, [pane]: true };
      this.onChange();
    }, this.grantDelayMs);
    return "opened";
  }
}

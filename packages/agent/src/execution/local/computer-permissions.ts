export type ComputerPermission = "accessibility" | "screen";

/**
 * Actionable instructions for missing macOS privacy permissions. They name the app macOS
 * attributes the daemon's permissions to (the Daily Do List app, or the terminal or editor the
 * daemon was started from) when it is known.
 */
export function permissionHelp(missing: readonly ComputerPermission[], host?: string): string {
  const app = host ? `“${host}”` : "the app that runs the Daily Do List daemon";
  const lines = [
    `Computer use needs macOS privacy permissions for ${app}${host ? "" : " (the Daily Do List app, or the terminal or editor it was started from)"}. Allow them in Daily Do List under Settings → Computer Use, or in System Settings:`,
  ];
  if (missing.includes("accessibility")) {
    lines.push(
      `• Accessibility (to operate apps, move the mouse and type): System Settings → Privacy & Security → Accessibility, turn on ${host ? app : "that app"}`,
    );
  }
  if (missing.includes("screen")) {
    lines.push(
      `• Screen Recording (to take screenshots): System Settings → Privacy & Security → Screen & System Audio Recording, turn on ${host ? app : "that app"}, then quit and reopen it`,
    );
  }
  lines.push(
    "Tell the user exactly what to allow and finish with needs_user; don't retry until they have.",
  );
  return lines.join("\n");
}

/** Which permissions a helper `permission` error names (both when it doesn't say). */
export function permissionsNamedIn(message: string): ComputerPermission[] {
  const named: ComputerPermission[] = [];
  if (/accessibility/i.test(message)) named.push("accessibility");
  if (/screen|recording|capture/i.test(message)) named.push("screen");
  return named.length > 0 ? named : ["accessibility", "screen"];
}

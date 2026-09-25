import type { AgentReadiness } from "@ddl/core";
import type { SettingsSection } from "../../state/ui-store";

export interface ReadinessRow {
  key: "harness" | "credential" | "browser" | "computer" | "connectors";
  label: string;
  /** `ok`, a problem to fix (`warning`), or something this machine just doesn't have (`none`). */
  state: "ok" | "warning" | "none";
  value: string;
  /** How to fix it. */
  hint?: string;
  /** Where in this device's Settings to fix it. */
  section?: SettingsSection;
}

const HARNESS_NAMES = { pi: "Pi", cursor: "Cursor CLI" } as const;

/**
 * What a daemon has for running the agent, row by row, with fix-it hints. `here`: this device
 * (hints can link to its Settings); `machine`: the always-on machine (hints say where to fix it).
 */
export function readinessRows(
  readiness: AgentReadiness,
  where: "here" | "machine",
): ReadinessRow[] {
  const on = where === "here" ? "on this device" : "on the machine";
  const harness = readiness.harness.kind === "cursor" ? "cursor" : "pi";
  const name = HARNESS_NAMES[harness];
  const { configured, connected } = readiness.connectors;
  return [
    {
      key: "harness",
      label: "Agent",
      state: readiness.harness.ready ? "ok" : "warning",
      value: readiness.harness.ready
        ? `${name} is ready`
        : (readiness.harness.problem ?? `${name} can't start`),
      ...(readiness.harness.ready
        ? {}
        : {
            hint:
              harness === "cursor"
                ? `Install the Cursor CLI ${on} and sign in with \`agent login\`.`
                : `The daemon's log ${on} says why Pi didn't start.`,
          }),
    },
    {
      key: "credential",
      label: "Model credential",
      state: readiness.modelCredential ? "ok" : "warning",
      value: readiness.modelCredential ? "Present" : "Missing",
      ...(readiness.modelCredential
        ? {}
        : {
            hint:
              harness === "cursor"
                ? `Sign the Cursor CLI in ${on} with \`agent login\`.`
                : `Add OPENROUTER_API_KEY to ~/.daily-do-list/.env ${on}.`,
          }),
    },
    {
      key: "browser",
      label: "Browser",
      state: readiness.browser ? "ok" : "warning",
      value: readiness.browser ? "Available" : "Not available",
      ...(readiness.browser ? {} : { hint: `Install Google Chrome or Chromium ${on}.` }),
    },
    {
      key: "computer",
      label: "Desktop control",
      state:
        readiness.computer === "available"
          ? "ok"
          : readiness.computer === "needs_permissions"
            ? "warning"
            : "none",
      value:
        readiness.computer === "available"
          ? "Available"
          : readiness.computer === "needs_permissions"
            ? "Needs permissions"
            : "Not on this machine",
      ...(readiness.computer === "needs_permissions"
        ? where === "here"
          ? { hint: "Grant Accessibility and Screen Recording.", section: "computer" as const }
          : { hint: "Grant Accessibility and Screen Recording on the machine." }
        : readiness.computer === "unsupported"
          ? { hint: "Operating other apps needs a Mac." }
          : {}),
    },
    {
      key: "connectors",
      label: "Connectors",
      state: configured === 0 ? "none" : connected < configured ? "warning" : "ok",
      value: configured === 0 ? "None set up" : `${connected} of ${configured} connected`,
      ...(configured === 0
        ? { hint: `Connectors are set up per machine, in ~/.daily-do-list/mcp.json ${on}.` }
        : connected < configured
          ? where === "here"
            ? { hint: "See which ones and why.", section: "connectors" as const }
            : { hint: "Its Settings → Connectors says which ones and why." }
          : {}),
    },
  ];
}

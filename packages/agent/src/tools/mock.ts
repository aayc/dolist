import { type ActionCategory, type ToolSpec, textResult, truncate } from "@ddl/core";
import { TOOL } from "./contracts";
import { asInput, guarded, requireString } from "./input";

const RISKY_VERB_RE = /\b(buy|order|book|reserve|email|send|pay)\b/i;

/** The irreversible verb in a task, if any (mock mode exercises the approval flow on these). */
export function riskyVerb(text: string): string | null {
  const match = RISKY_VERB_RE.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

export function categoryForVerb(verb: string): ActionCategory {
  switch (verb) {
    case "buy":
    case "order":
    case "pay":
      return "payment";
    case "book":
    case "reserve":
      return "booking";
    case "email":
    case "send":
      return "communication";
    default:
      return "unknown";
  }
}

/** A fake irreversible action (mock mode only): always requires approval, does nothing real. */
export function createMockIrreversibleActionTool(category: ActionCategory): ToolSpec {
  return {
    name: TOOL.mockIrreversibleAction,
    label: "Irreversible action (mock)",
    description:
      "Mock mode only: performs the final irreversible step of a task (purchase, booking, sending). Nothing real happens.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "The verb, e.g. book." },
        details: { type: "string", description: "What exactly would happen." },
      },
      required: ["action", "details"],
      additionalProperties: false,
    },
    safety: {
      alwaysRequireApproval: true,
      openWorld: true,
      category,
      describe: (input) => {
        const args = (input ?? {}) as { action?: unknown; details?: unknown };
        return truncate(
          `Mock ${String(args.action ?? "action")}: ${String(args.details ?? "")}`,
          200,
        );
      },
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const action = requireString(args, "action", { maxLength: 100 });
        const details = requireString(args, "details", { maxLength: 1_000 });
        return textResult(`Mock ${action} completed (nothing real happened): ${details}`);
      }),
  };
}

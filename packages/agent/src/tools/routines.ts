import { describeSchedulePhrase, type ToolSpec, textResult, truncate } from "@ddl/core";
import {
  type CreateRoutineInput,
  type RunRoutineInput,
  TOOL,
  type UpdateRoutineInput,
} from "./contracts";
import {
  asInput,
  guarded,
  optionalString,
  requireEnum,
  requireEnumArray,
  requireString,
  type ToolInput,
  ToolInputError,
} from "./input";
import { CAPABILITIES } from "./orchestrator";

const NOTIFY_VALUES = ["always", "when_changed", "never"] as const;

/**
 * What the routine tools do. The runtime implements it on the routine library and scheduler;
 * evals implement it to record decisions. Methods return what the model sees and throw
 * `ToolInputError` for requests it should correct (an unreadable schedule, an unknown routine).
 */
export interface RoutineToolHost {
  createRoutine(input: CreateRoutineInput): Promise<string>;
  updateRoutine(input: UpdateRoutineInput): Promise<string>;
  runRoutine(input: RunRoutineInput): Promise<string>;
  listRoutines(): Promise<string>;
}

const NAME = {
  type: "string",
  description: 'The routine\'s name, which is its file name in Routines/, e.g. "Morning briefing".',
} as const;

const SCHEDULE = {
  type: "string",
  description:
    'When it runs, in the user\'s local time: "every day at 7:30", "every weekday at 8:00", "every monday and thursday at 9", "every sunday at 18:00", "every hour", "every 30 minutes" (at least 15), "every 2 hours from 9:00 to 17:00 on weekdays", "every month on the 1st at 9:00". Join times with "and".',
} as const;

const NOTIFY = {
  type: "string",
  enum: [...NOTIFY_VALUES],
  description:
    '"when_changed" for watches and monitors (the user hears only when something changed), "always" for briefings and digests, "never" for quiet housekeeping.',
} as const;

const USES = {
  type: "array",
  items: { type: "string", enum: [...CAPABILITIES] },
  uniqueItems: true,
  description:
    'The fewest capabilities each run needs, e.g. ["web"]; its runs get exactly these (reading and writing notes is always allowed).',
} as const;

function field(input: unknown, key: string): string {
  const value =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : "";
  return typeof value === "string" ? value : "";
}

function quoted(name: string): string {
  return `“${truncate(name, 80)}”`;
}

/** "every weekday at 7:30" plus how often, in the approval card's words. */
function scheduleCard(schedule: string): string {
  return truncate(schedule.trim(), 120);
}

function describeUpdate(input: unknown): string {
  const name = quoted(field(input, "name"));
  const record = typeof input === "object" && input !== null ? (input as ToolInput) : {};
  const paused = record.paused;
  const changes: string[] = [];
  if (typeof record.schedule === "string") changes.push(scheduleCard(record.schedule));
  if (typeof record.instructions === "string") {
    changes.push(`new instructions “${truncate(record.instructions, 100)}”`);
  }
  if (typeof record.notify === "string") changes.push(`notify ${record.notify}`);
  if (Array.isArray(record.uses)) changes.push(`uses ${record.uses.join(", ") || "nothing"}`);
  if (changes.length === 0) {
    if (paused === true) return `Pause routine ${name}`;
    if (paused === false) return `Resume routine ${name}`;
    return `Change routine ${name}`;
  }
  const state = paused === true ? " (paused)" : paused === false ? " (resumed)" : "";
  return `Change routine ${name}${state}: ${changes.join("; ")}`;
}

function readSettings(args: ToolInput): Pick<CreateRoutineInput, "notify" | "uses"> {
  const out: Pick<CreateRoutineInput, "notify" | "uses"> = {};
  if (args.notify !== undefined && args.notify !== null) {
    out.notify = requireEnum(args, "notify", NOTIFY_VALUES);
  }
  if (args.uses !== undefined && args.uses !== null) {
    out.uses = requireEnumArray(args, "uses", CAPABILITIES);
  }
  return out;
}

export function createRoutineTools(host: RoutineToolHost): ToolSpec[] {
  const create: ToolSpec = {
    name: TOOL.createRoutine,
    label: "Create routine",
    description:
      "Create a routine: a standing job that runs on its own on a schedule (a morning briefing, a price watch, a weekly review). Writes Routines/<name>.md in the user's notes; each run reports in its own thread.",
    parameters: {
      type: "object",
      properties: {
        name: NAME,
        schedule: SCHEDULE,
        instructions: {
          type: "string",
          description:
            "What each run does, self-contained (a future run reads only this and the previous result): what to check and where, what to report, how short.",
        },
        notify: NOTIFY,
        uses: USES,
      },
      required: ["name", "schedule", "instructions"],
      additionalProperties: false,
    },
    safety: {
      category: "file_write",
      describe: (input) => {
        const schedule = field(input, "schedule");
        const words = describeSchedulePhrase(schedule);
        const what = truncate(field(input, "instructions"), 140);
        return `Create routine ${quoted(field(input, "name"))}: ${scheduleCard(schedule)}${words ? ` (${words})` : ""} — ${what}`;
      },
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        return textResult(
          await host.createRoutine({
            name: requireString(args, "name", { maxLength: 100 }),
            schedule: requireString(args, "schedule", { maxLength: 200 }),
            instructions: requireString(args, "instructions", { maxLength: 8_000 }),
            ...readSettings(args),
          }),
        );
      }),
  };

  const update: ToolSpec = {
    name: TOOL.updateRoutine,
    label: "Change routine",
    description:
      "Change a routine: pause or resume it (paused), or change its schedule, instructions, notify or uses. Only the fields given change.",
    parameters: {
      type: "object",
      properties: {
        name: NAME,
        paused: { type: "boolean", description: "true pauses it, false resumes it." },
        schedule: SCHEDULE,
        instructions: { type: "string", description: "The new instructions, self-contained." },
        notify: NOTIFY,
        uses: USES,
      },
      required: ["name"],
      additionalProperties: false,
    },
    safety: { category: "file_write", describe: describeUpdate },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const schedule = optionalString(args, "schedule", { maxLength: 200 });
        const instructions = optionalString(args, "instructions", { maxLength: 8_000 });
        const paused = args.paused;
        if (paused !== undefined && typeof paused !== "boolean") {
          throw new ToolInputError('"paused" must be true or false.');
        }
        const patch: UpdateRoutineInput = {
          name: requireString(args, "name", { maxLength: 100 }),
          ...(schedule ? { schedule } : {}),
          ...(instructions ? { instructions } : {}),
          ...readSettings(args),
          ...(typeof paused === "boolean" ? { paused } : {}),
        };
        if (Object.keys(patch).length === 1) {
          throw new ToolInputError(
            "Say what to change: paused, schedule, instructions, notify or uses.",
          );
        }
        return textResult(await host.updateRoutine(patch));
      }),
  };

  const run: ToolSpec = {
    name: TOOL.runRoutine,
    label: "Run routine now",
    description:
      "Run a routine right away, besides its schedule (a few extra runs a day at most). It reports in a new thread of its own.",
    parameters: {
      type: "object",
      properties: { name: NAME },
      required: ["name"],
      additionalProperties: false,
    },
    safety: {
      category: "compute",
      describe: (input) => `Run routine ${quoted(field(input, "name"))} now`,
    },
    execute: (input) =>
      guarded(async () =>
        textResult(
          await host.runRoutine({
            name: requireString(asInput(input), "name", { maxLength: 100 }),
          }),
        ),
      ),
  };

  const list: ToolSpec = {
    name: TOOL.listRoutines,
    label: "List routines",
    description:
      "List the user's routines: schedule, paused, next run, last run and its result, problems.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    safety: { readOnly: true, category: "read", describe: () => "List routines" },
    execute: () => guarded(async () => textResult(await host.listRoutines())),
  };

  return [create, update, run, list];
}

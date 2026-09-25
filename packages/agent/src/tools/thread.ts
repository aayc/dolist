import { type ArtifactMeta, type ToolSpec, textResult, truncate } from "@ddl/core";
import {
  type AskUserInput,
  type CreateArtifactInput,
  type FinishTaskInput,
  type PostUpdateInput,
  TOOL,
} from "./contracts";
import {
  asInput,
  guarded,
  optionalString,
  requireEnum,
  requireString,
  ToolInputError,
} from "./input";

const ARTIFACT_KINDS: readonly CreateArtifactInput["kind"][] = [
  "markdown",
  "code",
  "html",
  "json",
  "text",
];
const FINISH_STATUSES: readonly FinishTaskInput["status"][] = ["done", "failed", "needs_user"];
const MAX_ARTIFACT_CHARS = 1_000_000;

/** The subagent's link to its task thread; implemented per subagent by the SubagentManager. */
export interface ThreadToolHost {
  postUpdate(input: PostUpdateInput): void;
  askUser(input: AskUserInput): void;
  createArtifact(input: CreateArtifactInput): Promise<ArtifactMeta>;
  finish(input: FinishTaskInput): void;
}

/** Writes only to the task's own thread in the sidecar. */
const THREAD_ONLY = { readOnly: true, category: "compute" } as const;

/** Tools that are rendered as dedicated thread messages rather than tool-call rows. */
export const THREAD_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL.postUpdate,
  TOOL.askUser,
  TOOL.createArtifact,
  TOOL.finishTask,
]);

/** `routineRun`: the thread is a routine's run, whose `finish_task` also says whether anything changed. */
export function createThreadTools(
  host: ThreadToolHost,
  options: { routineRun?: boolean } = {},
): ToolSpec[] {
  const postUpdate: ToolSpec = {
    name: TOOL.postUpdate,
    label: "Post update",
    description:
      "Post a progress update to the task's thread at a meaningful milestone. Optionally update the badge next to the task.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Short markdown update." },
        summary: { type: "string", description: "New badge text, at most 6 words." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    safety: { ...THREAD_ONLY, describe: () => "Post a progress update" },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const summary = optionalString(args, "summary", { maxLength: 200 });
        host.postUpdate({
          text: requireString(args, "text", { maxLength: 8_000 }),
          ...(summary ? { summary } : {}),
        });
        return textResult("Update posted.");
      }),
  };

  const askUser: ToolSpec = {
    name: TOOL.askUser,
    label: "Ask the user",
    description:
      "Ask the user one specific question in the thread when you cannot proceed without their input. End your turn afterwards; the reply arrives as a new message.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    safety: { ...THREAD_ONLY, describe: () => "Ask the user a question" },
    execute: (input) =>
      guarded(async () => {
        host.askUser({ question: requireString(asInput(input), "question", { maxLength: 4_000 }) });
        return textResult(
          "Question sent to the user. End your turn now; their reply will arrive as a new message.",
        );
      }),
  };

  const createArtifact: ToolSpec = {
    name: TOOL.createArtifact,
    label: "Create artifact",
    description:
      "Save a substantial output (draft, comparison, research notes, plan, code) as an artifact attached to the task's thread.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: [...ARTIFACT_KINDS] },
        content: { type: "string" },
        language: { type: "string", description: "Language for code artifacts, e.g. python." },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
    safety: {
      ...THREAD_ONLY,
      describe: (input) =>
        `Create artifact: ${truncate(String((input as { title?: unknown })?.title ?? ""), 100)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const language = optionalString(args, "language", { maxLength: 40 });
        const content = args.content;
        if (typeof content !== "string" || content.trim().length === 0) {
          throw new ToolInputError('"content" is required and must be a non-empty string.');
        }
        if (content.length > MAX_ARTIFACT_CHARS) {
          throw new ToolInputError(
            `"content" is too large (max ${MAX_ARTIFACT_CHARS} characters).`,
          );
        }
        const meta = await host.createArtifact({
          title: requireString(args, "title", { maxLength: 200 }),
          kind: requireEnum(args, "kind", ARTIFACT_KINDS),
          content,
          ...(language ? { language } : {}),
        });
        return textResult(`Artifact saved: "${meta.title}" (${meta.id}).`, { artifactId: meta.id });
      }),
  };

  const finishTask: ToolSpec = {
    name: TOOL.finishTask,
    label: "Finish task",
    description:
      'Report the outcome and end your work: "done", "needs_user" (say exactly what you need), or "failed" (say why).',
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...FINISH_STATUSES] },
        summary: {
          type: "string",
          description: "Markdown: result first, then key details, links, next steps.",
        },
        shortSummary: { type: "string", description: "Badge text, at most 6 words." },
        ...(options.routineRun
          ? {
              changed: {
                type: "boolean",
                description:
                  "Whether anything is new or different since the routine's previous run that the user should hear about.",
              },
            }
          : {}),
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
    safety: {
      ...THREAD_ONLY,
      describe: (input) => `Finish task (${String((input as { status?: unknown })?.status ?? "")})`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const shortSummary = optionalString(args, "shortSummary", { maxLength: 200 });
        const changed = options.routineRun ? args.changed : undefined;
        if (changed !== undefined && typeof changed !== "boolean") {
          throw new ToolInputError('"changed" must be true or false.');
        }
        host.finish({
          status: requireEnum(args, "status", FINISH_STATUSES),
          summary: requireString(args, "summary", { maxLength: 20_000 }),
          ...(shortSummary ? { shortSummary } : {}),
          ...(changed !== undefined ? { changed } : {}),
        });
        return textResult("Recorded. Your work on this task is complete; end your turn.");
      }),
  };

  return [postUpdate, askUser, createArtifact, finishTask];
}

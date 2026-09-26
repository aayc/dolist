/**
 * Triage eval: for each synthetic task (in isolation) does the orchestrator pick the right outcome
 * — delegate / comment / ask_user / ignore, or a routine for something recurring — and the right
 * subagent capabilities (a routine's `uses`, schedule and notify), and how quickly does it make its
 * first tool call?
 *
 * Both modes run the real orchestrator system prompt, event digest and orchestrator tools, with the
 * tools' host stubbed to RECORD decisions (no subagents run, nothing is written):
 *  - live: PiHarness on OpenRouter (web tools are real when available);
 *  - mock: a ScriptedHarness driven by the fake brain (`@ddl/agent/testing`, what
 *    `DDL_AGENT_MODE=mock` runs) — validates the dataset and the eval plumbing deterministically.
 *    Its keyword triage is tuned to this dataset; it says nothing about model quality.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOrchestratorSystemPrompt,
  CAPABILITIES,
  type Capability,
  createOrchestratorTools,
  createRoutineTools,
  type DigestLine,
  DrawingDescriptions,
  drawingBudget,
  formatOrchestratorDigest,
  type Harness,
  type OrchestratorToolHost,
  type RoutineToolHost,
  ScriptedHarness,
  TOOL,
  ToolInputError,
} from "@ddl/agent";
import { createFakeAgentScript, createFakeBrain, flowchartDrawing } from "@ddl/agent/testing";
import {
  addDays,
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  dailyNotePath,
  describeSchedulePhrase,
  errorResult,
  ROUTINE_NOTIFY_VALUES,
  type RoutineNotify,
  type ToolSpec,
  textResult,
  today,
  toISODate,
  withTimeout,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import type { EvalCaseResult, EvalMode, EvalSuite, EvalSuiteResult } from "../types";

/** `routine`: something recurring, turned into a routine (create_routine) instead of done once. */
type TaskDecision = "delegate" | "comment" | "ask_user" | "ignore" | "routine";
/**
 * What the orchestrator did about the case's task when the user wrote to it in its chat: dropped
 * it (cancel_subagent, or set_task_status "ignored"), passed the message on to its subagent, only
 * replied, or created the routine the message asked for.
 */
type DirectDecision = "drop" | "forward" | "reply" | "routine";
type Decision = TaskDecision | DirectDecision;

const DECISIONS: readonly TaskDecision[] = ["delegate", "comment", "ask_user", "ignore", "routine"];
const DIRECT_DECISIONS: readonly DirectDecision[] = ["drop", "forward", "reply", "routine"];
const MIN_CASES = 40;
const MIN_CASES_PER_DECISION = 5;
const MIN_DIRECT_CASES_PER_DECISION = 2;
const CASE_TIMEOUT_MS = 90_000;
const CASE_TASK_ID = "tsk_case000001";

interface TriageCase {
  id: string;
  task: string;
  notes?: string[];
  expected: Decision;
  /** Capabilities a delegation (or a routine's `uses`) must include (recall is measured against these). */
  capabilities?: Capability[];
  /** What the routine must say (`expected: "routine"`): its schedule, compared in words, and notify. */
  routine?: { schedule?: string; notify?: RoutineNotify };
  /** Other decisions that are also fine for this task. */
  acceptable?: Decision[];
  /** The digest says computer access isn't allowed (default: allowed). */
  computerAccess?: "missing";
  /**
   * The user writes this to the orchestrator in its chat. The task is then already on the list
   * (not changed) with `agentStatus`, and `expected` is a direct decision.
   */
  direct?: string;
  /** Agent status of a direct case's task (default `working`: a subagent is on it). */
  agentStatus?: "working" | "done" | "waiting_user";
  /**
   * A drawing embedded right under the task (`![[<name>.excalidraw|360|right-wrap]]`), which the
   * digest describes: labeled boxes in a row and arrows between them.
   */
  drawing?: { name: string; boxes: string[]; arrows?: Array<[string, string, string?]> };
  /** Words a delegation's goal or instructions must contain (e.g. the drawing's labels). */
  mentions?: string[];
}

interface RecordedCall {
  tool: string;
  input: Record<string, unknown>;
}

/** The routine a create_routine call asked for. */
interface CreatedRoutine {
  schedule: string;
  notify?: RoutineNotify;
  uses: Capability[];
}

interface Outcome {
  decision: Decision;
  capabilities: Capability[];
  routine?: CreatedRoutine;
  calls: RecordedCall[];
  /** The text of the turn (the reply to a direct message). */
  reply: string;
  firstToolMs: number | null;
  turnMs: number;
  error?: string;
}

const FILLER_TASKS = [
  { taskId: "tsk_filler0001", text: "Pay rent", checkbox: "done" as const, notes: [] },
  {
    taskId: "tsk_filler0002",
    text: "Reply to Alex about the offsite",
    checkbox: "open" as const,
    notes: [],
    agentStatus: "working" as const,
    agentSummary: "Drafting reply",
  },
];
const KNOWN_TASK_IDS = new Set([CASE_TASK_ID, ...FILLER_TASKS.map((t) => t.taskId)]);

/** The Mac's apps as the digest lists them (running ones first); the fake brain's tests read it too. */
const DESKTOP_APPS: string[] = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../datasets/triage-desktop-apps.json"),
    "utf8",
  ),
);

// ── Dataset ─────────────────────────────────────────────────────────────────

const datasetPath = join(dirname(fileURLToPath(import.meta.url)), "../../datasets/triage.jsonl");

function loadDataset(): { cases: TriageCase[]; problems: string[] } {
  const problems: string[] = [];
  const cases: TriageCase[] = [];
  const ids = new Set<string>();
  const lines = readFileSync(datasetPath, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      problems.push(`line ${index + 1}: invalid JSON`);
      return;
    }
    const c = raw as Partial<TriageCase>;
    const where = `line ${index + 1} (${String(c.id)})`;
    if (typeof c.id !== "string" || !/^[a-z0-9-]+$/.test(c.id)) problems.push(`${where}: bad id`);
    else if (ids.has(c.id)) problems.push(`${where}: duplicate id`);
    else ids.add(c.id);
    if (typeof c.task !== "string" || c.task.trim().length < 3) problems.push(`${where}: bad task`);
    const decisions: readonly Decision[] = c.direct === undefined ? DECISIONS : DIRECT_DECISIONS;
    if (!decisions.includes(c.expected as Decision)) problems.push(`${where}: bad expected`);
    if (c.direct !== undefined && (typeof c.direct !== "string" || c.direct.trim().length < 2)) {
      problems.push(`${where}: bad direct message`);
    }
    if (c.agentStatus !== undefined && c.direct === undefined) {
      problems.push(`${where}: agentStatus only applies to direct cases`);
    }
    if (
      c.notes !== undefined &&
      !(Array.isArray(c.notes) && c.notes.every((n) => typeof n === "string"))
    ) {
      problems.push(`${where}: notes must be strings`);
    }
    if (c.routine !== undefined) {
      if (c.expected !== "routine") problems.push(`${where}: routine only applies to routine`);
      if (c.routine.schedule !== undefined && !describeSchedulePhrase(c.routine.schedule)) {
        problems.push(`${where}: unreadable schedule`);
      }
      if (c.routine.notify !== undefined && !ROUTINE_NOTIFY_VALUES.includes(c.routine.notify)) {
        problems.push(`${where}: bad notify`);
      }
    }
    if (c.capabilities !== undefined) {
      if (c.expected !== "delegate" && c.expected !== "routine") {
        problems.push(`${where}: capabilities only apply to delegate and routine`);
      }
      if (
        !Array.isArray(c.capabilities) ||
        !c.capabilities.every((x) => CAPABILITIES.includes(x))
      ) {
        problems.push(`${where}: unknown capability`);
      }
    }
    if (c.acceptable !== undefined && !c.acceptable.every((d) => decisions.includes(d))) {
      problems.push(`${where}: bad acceptable decision`);
    }
    if (c.computerAccess !== undefined && c.computerAccess !== "missing") {
      problems.push(`${where}: computerAccess can only be "missing"`);
    }
    if (c.drawing !== undefined) {
      const { name, boxes, arrows = [] } = c.drawing;
      const labels = new Set(Array.isArray(boxes) ? boxes : []);
      if (typeof name !== "string" || !/^[\w -]{1,60}$/.test(name) || labels.size === 0) {
        problems.push(`${where}: a drawing needs a plain name and boxes`);
      } else if (!arrows.every(([from, to]) => labels.has(from) && labels.has(to))) {
        problems.push(`${where}: a drawing's arrows must connect its boxes`);
      }
    }
    if (c.mentions !== undefined) {
      if (c.expected !== "delegate") problems.push(`${where}: mentions only apply to delegate`);
      if (!Array.isArray(c.mentions) || !c.mentions.every((m) => typeof m === "string" && m)) {
        problems.push(`${where}: mentions must be non-empty strings`);
      }
    }
    cases.push(c as TriageCase);
  });
  if (cases.length < MIN_CASES) problems.push(`only ${cases.length} cases (need ${MIN_CASES})`);
  const minimums: Array<[Decision, number]> = [
    ...DECISIONS.map((d): [Decision, number] => [d, MIN_CASES_PER_DECISION]),
    ...DIRECT_DECISIONS.map((d): [Decision, number] => [d, MIN_DIRECT_CASES_PER_DECISION]),
  ];
  for (const [decision, minimum] of minimums) {
    const count = cases.filter((c) => c.expected === decision).length;
    if (count < minimum) problems.push(`only ${count} "${decision}" cases`);
  }
  return { cases, problems };
}

/** `{{+7d}}` in a task becomes the ISO date 7 days from today (deferral links stay in the future). */
function resolveTemplates(text: string, now: number): string {
  return text.replace(/\{\{\+(\d+)d\}\}/g, (_, days: string) =>
    toISODate(addDays(today(new Date(now)), Number(days))),
  );
}

/**
 * The whole-note view of a case with a drawing: the task, the embed under it described by the
 * runtime's own `DrawingDescriptions`, then the filler tasks.
 */
async function drawingView(c: TriageCase, text: string): Promise<DigestLine[] | undefined> {
  if (!c.drawing) return undefined;
  const { name, boxes, arrows } = c.drawing;
  const storage = new MemoryStorageProvider({
    initialFiles: {
      [`Excalidraw/${name}.excalidraw.md`]: flowchartDrawing({
        boxes,
        ...(arrows ? { arrows } : {}),
      }),
    },
  });
  const lines: DigestLine[] = [
    { n: 1, text: `- [ ] ${text}`, taskId: CASE_TASK_ID },
    { n: 2, text: `![[${name}.excalidraw|360|right-wrap]]` },
    ...FILLER_TASKS.map((task, i) => ({
      n: i + 3,
      text: `- [${task.checkbox === "done" ? "x" : " "}] ${task.text}`,
      taskId: task.taskId,
      ...(task.agentStatus ? { agentStatus: task.agentStatus } : {}),
      ...(task.agentSummary ? { agentSummary: task.agentSummary } : {}),
    })),
  ];
  const drawings = new DrawingDescriptions({ storage });
  const blocks = await drawings.blocks(lines.map((line) => line.text).join("\n"), drawingBudget());
  for (const block of blocks) lines[block.line]!.drawing = block.lines;
  return lines;
}

async function digestFor(c: TriageCase, now: number): Promise<string> {
  const day = today(new Date(now));
  const text = resolveTemplates(c.task, now);
  const direct = c.direct !== undefined;
  const status = c.agentStatus ?? "working";
  const view = await drawingView(c, text);
  return formatOrchestratorDigest({
    now,
    notes: [
      {
        notePath: dailyNotePath(day, DEFAULT_SETTINGS.dailyNotes),
        date: toISODate(day),
        ...(view ? { view } : {}),
        changed: direct
          ? []
          : [
              {
                taskId: CASE_TASK_ID,
                change: "added",
                text,
                checkbox: "open",
                notes: c.notes ?? [],
              },
            ],
        others: direct
          ? [
              {
                taskId: CASE_TASK_ID,
                text,
                checkbox: "open",
                notes: [],
                agentStatus: status,
              },
              ...FILLER_TASKS,
            ]
          : FILLER_TASKS,
      },
    ],
    replies: [],
    reports: [],
    ...(direct ? { direct: [c.direct!] } : {}),
    subagents: [
      ...(direct && status === "working"
        ? [{ taskId: CASE_TASK_ID, taskText: text, status, runningForMs: 300_000 }]
        : []),
      {
        taskId: "tsk_filler0002",
        taskText: "Reply to Alex about the offsite",
        status: "working",
        runningForMs: 120_000,
        summary: "Drafting reply",
      },
    ],
    capabilities: {
      available: ["web", "browser", "computer", "files", "shell", "connectors"],
      unavailable: [],
      connectors: [
        { name: "gmail", state: "connected", toolCount: 12 },
        { name: "google-calendar", state: "connected", toolCount: 6 },
      ],
      computer: {
        apps: DESKTOP_APPS,
        moreApps: 23,
        access: {
          accessibility: c.computerAccess !== "missing",
          screenRecording: c.computerAccess !== "missing",
          appControl: true,
          host: "Daily Do List",
        },
      },
    },
  });
}

// ── Recording tools ─────────────────────────────────────────────────────────

function recordingHost(calls: RecordedCall[]): OrchestratorToolHost {
  const record = (tool: string, input: object) => {
    const args = input as Record<string, unknown>;
    if (typeof args.taskId === "string" && !KNOWN_TASK_IDS.has(args.taskId)) {
      throw new ToolInputError(`Unknown task id "${args.taskId}". Use the ids from the digest.`);
    }
    calls.push({ tool, input: args });
  };
  return {
    spawnSubagent: async (input) => {
      record(TOOL.spawnSubagent, input);
      return `Subagent started for ${input.taskId}.`;
    },
    postComment: async (input) => {
      record(TOOL.postComment, input);
      return "Comment posted.";
    },
    askUser: async (input) => {
      record(TOOL.askUser, input);
      return "Question posted. The user's reply will arrive as a new event.";
    },
    setTaskStatus: async (input) => {
      record(TOOL.setTaskStatus, input);
      return `Status set to ${input.status}.`;
    },
    messageSubagent: async (input) => {
      record(TOOL.messageSubagent, input);
      return "Message delivered.";
    },
    cancelSubagent: async (input) => {
      record(TOOL.cancelSubagent, input);
      return "Subagent cancelled.";
    },
    listTasks: async (input) => {
      record(TOOL.listTasks, input);
      return FILLER_TASKS.map((t) => `- ${t.taskId}: "${t.text}"`).join("\n");
    },
    anchorLine: async (input) => {
      record(TOOL.anchorLine, input);
      return "Attached anc_eval to the line. Use it as the taskId.";
    },
  };
}

/** Records routine decisions; a schedule the app couldn't read is refused, as the real tool does. */
function recordingRoutineHost(calls: RecordedCall[]): RoutineToolHost {
  const record = (tool: string, input: object) => {
    calls.push({ tool, input: { ...(input as Record<string, unknown>) } });
  };
  return {
    createRoutine: async (input) => {
      const words = describeSchedulePhrase(input.schedule);
      if (!words) {
        throw new ToolInputError(
          `Couldn't read the schedule “${input.schedule}”: use one of the phrases this tool lists.`,
        );
      }
      record(TOOL.createRoutine, input);
      return `Created routine “${input.name}”: ${words} · notify ${input.notify ?? "always"}. It's the file Routines/${input.name}.md; each run reports in its own thread under Routines.`;
    },
    updateRoutine: async (input) => {
      record(TOOL.updateRoutine, input);
      return `Updated routine “${input.name}”.`;
    },
    runRoutine: async (input) => {
      record(TOOL.runRoutine, input);
      return `Started a run of “${input.name}”.`;
    },
    listRoutines: async () => {
      record(TOOL.listRoutines, {});
      return "No routines yet (the Routines/ folder is empty).";
    },
  };
}

/** The routine the case's turn created, if any. */
function createdRoutine(calls: RecordedCall[]): CreatedRoutine | undefined {
  const call = calls.find((c) => c.tool === TOOL.createRoutine);
  if (!call) return undefined;
  const { schedule, notify, uses } = call.input;
  return {
    schedule: typeof schedule === "string" ? schedule : "",
    ...(typeof notify === "string" ? { notify: notify as RoutineNotify } : {}),
    uses: Array.isArray(uses) ? (uses as Capability[]) : [],
  };
}

const readNoteStub: ToolSpec = {
  name: TOOL.readNote,
  label: "Read note",
  description: "Read a note from the user's vault by path.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  safety: { readOnly: true, category: "read" },
  execute: async () => errorResult("Note not found."),
};

function stubWebTools(): ToolSpec[] {
  const unavailable = async () =>
    textResult(
      "Web access is unavailable in this eval; answer from your own knowledge if you can.",
    );
  return [
    {
      name: TOOL.webSearch,
      label: "Web search",
      description: "Search the web.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      safety: { readOnly: true, category: "network" },
      execute: unavailable,
    },
    {
      name: TOOL.webFetch,
      label: "Fetch page",
      description: "Fetch a web page as text.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      safety: { readOnly: true, category: "network" },
      execute: unavailable,
    },
  ];
}

/** What a direct message led to for the case's task. */
function decideDirect(calls: RecordedCall[], reply: string): Decision {
  if (createdRoutine(calls)) return "routine";
  const own = calls.filter((c) => c.input.taskId === CASE_TASK_ID);
  const dropped = own.some(
    (c) =>
      c.tool === TOOL.cancelSubagent ||
      (c.tool === TOOL.setTaskStatus && c.input.status === "ignored"),
  );
  if (dropped) return "drop";
  if (own.some((c) => c.tool === TOOL.messageSubagent || c.tool === TOOL.spawnSubagent)) {
    return "forward";
  }
  // Silence isn't a reply: without text the user sees nothing.
  return reply.trim() ? "reply" : "ignore";
}

/** How the runtime would interpret the calls made for the case's task. */
function decide(calls: RecordedCall[]): { decision: Decision; capabilities: Capability[] } {
  const routine = createdRoutine(calls);
  if (routine) return { decision: "routine", capabilities: routine.uses };
  const own = calls.filter((c) => c.input.taskId === CASE_TASK_ID);
  const spawn = own.find((c) => c.tool === TOOL.spawnSubagent);
  if (spawn) {
    const caps = Array.isArray(spawn.input.capabilities) ? spawn.input.capabilities : [];
    return { decision: "delegate", capabilities: caps as Capability[] };
  }
  if (own.some((c) => c.tool === TOOL.askUser)) return { decision: "ask_user", capabilities: [] };
  const status = own.filter((c) => c.tool === TOOL.setTaskStatus).at(-1)?.input.status;
  if (status === "ignored") return { decision: "ignore", capabilities: [] };
  if (own.some((c) => c.tool === TOOL.postComment) || status === "done") {
    return { decision: "comment", capabilities: [] };
  }
  // No action: the runtime resolves untouched tasks to "ignored".
  return { decision: "ignore", capabilities: [] };
}

async function runCase(
  harness: Harness,
  c: TriageCase,
  options: { model: string; webTools: ToolSpec[]; cwd: string },
): Promise<Outcome> {
  const calls: RecordedCall[] = [];
  const texts: string[] = [];
  let firstToolAt: number | null = null;
  let error: string | undefined;
  const session = await harness.createSession({
    sessionId: `orchestrator:eval-${c.id}`,
    role: "orchestrator",
    systemPrompt: buildOrchestratorSystemPrompt(),
    tools: [
      ...createOrchestratorTools(recordingHost(calls)),
      readNoteStub,
      ...options.webTools,
      ...createRoutineTools(recordingRoutineHost(calls)),
    ],
    model: options.model,
    thinking: "low",
    cwd: options.cwd,
    beforeToolCall: async () => ({ allow: true }),
    onEvent: (event) => {
      if (event.type === "tool_start" && firstToolAt === null) firstToolAt = performance.now();
      if (event.type === "message_end" && event.text.trim()) texts.push(event.text.trim());
      if (event.type === "error") error = event.message;
    },
  });
  const started = performance.now();
  try {
    const digest = await digestFor(c, Date.now());
    await withTimeout(session.prompt(digest), CASE_TIMEOUT_MS, "case timed out");
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    await session.abort().catch(() => {});
  } finally {
    await session.dispose().catch(() => {});
  }
  const turnMs = performance.now() - started;
  const firstToolMs = firstToolAt === null ? null : (firstToolAt as number) - started;
  const reply = texts.join("\n\n");
  const decision =
    c.direct === undefined
      ? decide(calls)
      : { decision: decideDirect(calls, reply), capabilities: createdRoutine(calls)?.uses ?? [] };
  const routine = createdRoutine(calls);
  return {
    ...decision,
    ...(routine ? { routine } : {}),
    calls,
    reply,
    firstToolMs,
    turnMs,
    ...(error ? { error } : {}),
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
}

/** How the routine the turn created differs from what the case expects. */
function routineMismatches(c: TriageCase, routine: CreatedRoutine | undefined): string[] {
  if (!routine || !c.routine) return [];
  const mismatches: string[] = [];
  if (c.routine.schedule !== undefined) {
    const expected = describeSchedulePhrase(c.routine.schedule);
    const actual = describeSchedulePhrase(routine.schedule);
    if (actual !== expected) {
      mismatches.push(
        `schedule “${routine.schedule}” (${actual ?? "unreadable"}), not ${expected}`,
      );
    }
  }
  const notify = routine.notify ?? "always";
  if (c.routine.notify !== undefined && notify !== c.routine.notify) {
    mismatches.push(`notify ${notify}, not ${c.routine.notify}`);
  }
  return mismatches;
}

/** What a delegation's goal and instructions leave out of the words the case needs said. */
function unmentioned(c: TriageCase, outcome: Outcome): string[] {
  if (!c.mentions || outcome.decision !== "delegate") return [];
  const spawn = outcome.calls.find(
    (call) => call.tool === TOOL.spawnSubagent && call.input.taskId === CASE_TASK_ID,
  );
  const said = `${String(spawn?.input.goal ?? "")} ${String(spawn?.input.instructions ?? "")}`;
  return c.mentions.filter((word) => !said.toLowerCase().includes(word.toLowerCase()));
}

function score(
  c: TriageCase,
  outcome: Outcome,
): EvalCaseResult & { recall: number | null; mentioned: boolean | null } {
  const allowed = [c.expected, ...(c.acceptable ?? [])];
  const decisionOk = allowed.includes(outcome.decision);
  const missingWords = unmentioned(c, outcome);
  const granted = outcome.decision === "delegate" || outcome.decision === "routine";
  const missing =
    granted && c.capabilities
      ? c.capabilities.filter((cap) => !outcome.capabilities.includes(cap))
      : [];
  const recall =
    granted && outcome.decision === c.expected && c.capabilities?.length
      ? (c.capabilities.length - missing.length) / c.capabilities.length
      : null;
  const routineIssues = outcome.decision === "routine" ? routineMismatches(c, outcome.routine) : [];
  const notes: string[] = [];
  const replyMissing = c.direct !== undefined && !outcome.reply.trim();
  if (outcome.error) notes.push(`error: ${outcome.error}`);
  if (missing.length > 0) notes.push(`missing capabilities: ${missing.join(", ")}`);
  if (missingWords.length > 0) notes.push(`instructions leave out: ${missingWords.join(", ")}`);
  notes.push(...routineIssues);
  if (replyMissing) notes.push("no reply in the chat");
  if (outcome.calls.length === 0) notes.push("no tool calls");
  const stray = outcome.calls.filter(
    (call) => call.input.taskId && call.input.taskId !== CASE_TASK_ID,
  );
  if (stray.length > 0) notes.push(`acted on other tasks: ${stray.map((s) => s.tool).join(", ")}`);
  return {
    id: c.id,
    passed:
      decisionOk &&
      missing.length === 0 &&
      missingWords.length === 0 &&
      routineIssues.length === 0 &&
      !replyMissing &&
      !outcome.error,
    expected: {
      decision: c.expected,
      ...(c.capabilities ? { capabilities: c.capabilities } : {}),
      ...(c.routine ? { routine: c.routine } : {}),
    },
    actual: {
      decision: outcome.decision,
      ...(outcome.decision === "delegate" ? { capabilities: outcome.capabilities } : {}),
      ...(outcome.routine ? { routine: outcome.routine } : {}),
      tools: outcome.calls.map((call) => call.tool),
    },
    latencyMs: Math.round(outcome.firstToolMs ?? outcome.turnMs),
    ...(notes.length > 0 ? { notes: notes.join("; ") } : {}),
    recall,
    mentioned: c.mentions ? outcome.decision === "delegate" && missingWords.length === 0 : null,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function run(options: {
  mode: EvalMode;
  filter?: string;
  concurrency: number;
}): Promise<EvalSuiteResult> {
  const { mode } = options;
  const { cases: all, problems } = loadDataset();
  const cases = options.filter ? all.filter((c) => c.id.includes(options.filter!)) : all;
  const thresholds: Record<string, number> =
    mode === "mock"
      ? { datasetValid: 1, accuracy: 0.9, mentionRecall: 1 }
      : { accuracy: 0.8, capabilityRecall: 0.75, mentionRecall: 0.75, p95FirstToolMs: 6_000 };

  let harness: Harness;
  let webTools: ToolSpec[] = stubWebTools();
  let cleanup = async () => {};
  const model = process.env.DDL_MODEL || DEFAULT_MODEL;
  if (mode === "mock") {
    harness = new ScriptedHarness({ scriptFor: createFakeAgentScript(createFakeBrain()) });
  } else {
    const apiKey = process.env.OPENROUTER_API_KEY ?? "";
    const { createOpenRouterClient, createWebTools } = await import("@ddl/agent");
    const { createPiHarness } = await import("@ddl/agent/pi");
    const home = await mkdtemp(join(tmpdir(), "ddl-eval-triage-"));
    cleanup = () => rm(home, { recursive: true, force: true });
    harness = createPiHarness({ apiKey, home });
    try {
      const llm = createOpenRouterClient({
        apiKey,
        defaultModel: model,
        appName: "Daily Do List evals",
      });
      webTools = createWebTools({ llm });
    } catch (error) {
      console.warn(`triage: web tools unavailable, using stubs (${String(error)})`);
    }
  }

  let outcomes: Array<ReturnType<typeof score>>;
  try {
    outcomes = await mapPool(cases, mode === "mock" ? 8 : options.concurrency, async (c) =>
      score(c, await runCase(harness, c, { model, webTools, cwd: tmpdir() })),
    );
  } finally {
    await cleanup();
  }

  const decisionCorrect = outcomes.filter((o, i) => {
    const c = cases[i]!;
    const actual = (o.actual as { decision: Decision }).decision;
    return [c.expected, ...(c.acceptable ?? [])].includes(actual);
  }).length;
  const recalls = outcomes.map((o) => o.recall).filter((r): r is number => r !== null);
  const mentioned = outcomes.map((o) => o.mentioned).filter((m): m is boolean => m !== null);
  const firstTool = outcomes
    .filter((o) => !(o.notes ?? "").includes("no tool calls"))
    .map((o) => o.latencyMs);
  const metrics: Record<string, number> = {
    cases: cases.length,
    datasetValid: problems.length === 0 ? 1 : 0,
    accuracy: cases.length ? decisionCorrect / cases.length : 0,
    passRate: cases.length ? outcomes.filter((o) => o.passed).length / cases.length : 0,
    capabilityRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : 1,
    // Delegations that passed on what the digest described (the drawings' labels).
    mentionRecall: mentioned.length ? mentioned.filter(Boolean).length / mentioned.length : 1,
    p50FirstToolMs: percentile(firstTool, 50),
    p95FirstToolMs: percentile(firstTool, 95),
    errors: outcomes.filter((o) => (o.notes ?? "").includes("error:")).length,
  };

  const results: EvalCaseResult[] = outcomes.map(
    ({ recall: _, mentioned: __, ...result }) => result,
  );
  if (problems.length > 0) {
    results.unshift({
      id: "dataset",
      passed: false,
      expected: "valid dataset",
      actual: problems,
      latencyMs: 0,
      notes: problems.slice(0, 5).join("; "),
    });
  }
  const passed = Object.entries(thresholds).every(([key, threshold]) => {
    const value = metrics[key] ?? 0;
    return key.endsWith("Ms") ? value <= threshold : value >= threshold;
  });
  return { suite: "triage", mode, cases: results, metrics, passed, thresholds };
}

const suite: EvalSuite = {
  name: "triage",
  description:
    "Orchestrator triage decisions (delegate/comment/ask_user/ignore), capability choice and time to first tool call.",
  run,
};

export default suite;

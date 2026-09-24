/**
 * `FakeBrain`: a deterministic, free, instant stand-in for the model. `policy()` is a pure function
 * of the request (role detected from tools / response format / plugins); tests layer behavior on
 * top with rules (`when`), exact queued turns (`enqueue`) and faults (`fail`, `hang`,
 * `corruptToolArgs`, `unknownTool`), all of which are recorded in `decisions`.
 */
import type { Capability } from "../../execution/types";
import { genericTurn, jsonTurn } from "./generic";
import { judgeTurn } from "./judge";
import { orchestratorTurn } from "./orchestrator";
import { subagentTurn } from "./subagent";
import { estimateTokens } from "./text";
import { detectRole, turnInfo } from "./transcript";
import type {
  AssistantTurn,
  BrainDecision,
  BrainMatcher,
  BrainRequest,
  BrainRole,
  TurnInfo,
  TurnToolCall,
} from "./types";
import { webSearchTurn } from "./web-search";

export interface FakeBrainOptions {
  /** 0 (default) keeps the canonical phrasing; other seeds pick deterministic variations. */
  seed?: number;
  /**
   * Keep the agent away from anything with real-world reach: grant only web/files and call only
   * thread, note, web_search and mock tools (never browser, shell, computer, MCP or web_fetch).
   * Mock mode and `pnpm dev:fake` run sandboxed.
   */
  sandbox?: boolean;
  /** Tools never to call, on top of the sandbox. */
  avoidTools?: readonly string[];
  /** Appended to subagent summaries. */
  disclaimer?: string;
}

export interface RuleOptions {
  /** How many requests the rule answers before it retires. Default: unlimited. */
  times?: number;
  name?: string;
}

export type TurnFactory = (request: BrainRequest, info: TurnInfo) => AssistantTurn;

export interface FaultOptions {
  role?: BrainMatcher;
  /** Default 1. */
  times?: number;
}

export type ArgsCorruption = "invalid-json" | "schema" | "wrong-type";

interface Rule {
  name: string;
  match: BrainMatcher;
  turn: AssistantTurn | TurnFactory;
  remaining: number;
}

interface Corruption {
  tool: string;
  mode: ArgsCorruption;
  remaining: number;
}

interface Queued {
  role?: BrainRole;
  turn: AssistantTurn;
}

export const DEFAULT_DISCLAIMER = "*(Fake agent — nothing real happened.)*";

const SANDBOX_TOOLS: ReadonlySet<string> = new Set([
  "post_update",
  "ask_user",
  "create_artifact",
  "finish_task",
  "read_note",
  "search_notes",
  "web_search",
  "mock_irreversible_action",
  "spawn_subagent",
  "post_comment",
  "set_task_status",
  "message_subagent",
  "cancel_subagent",
  "list_tasks",
]);
const SANDBOX_CAPABILITIES: readonly Capability[] = ["web", "files"];

export class FakeBrain {
  readonly seed: number;
  readonly sandbox: boolean;
  /** Every decision, in order. */
  readonly decisions: BrainDecision[] = [];
  private readonly avoid: ReadonlySet<string>;
  private readonly disclaimer: string;
  private rules: Rule[] = [];
  private queue: Queued[] = [];
  private failures: Array<{ match?: BrainMatcher; remaining: number; turn: AssistantTurn }> = [];
  private corruptions: Corruption[] = [];
  private unknownTools: Array<{ match?: BrainMatcher; remaining: number }> = [];

  constructor(options: FakeBrainOptions = {}) {
    this.seed = options.seed ?? 0;
    this.sandbox = options.sandbox ?? false;
    this.avoid = new Set(options.avoidTools ?? []);
    this.disclaimer = options.disclaimer ?? DEFAULT_DISCLAIMER;
  }

  /** The next assistant turn for this request. */
  decide(request: BrainRequest): AssistantTurn {
    const role = detectRole(request);
    const info = turnInfo(request, role);
    const decision = this.choose(request, info);
    this.decisions.push(decision);
    return decision.turn;
  }

  /** The built-in behavior alone: a pure function of the request. */
  policy(request: BrainRequest, role: BrainRole = detectRole(request)): AssistantTurn {
    switch (role) {
      case "orchestrator":
        return withReasoning(
          orchestratorTurn(request, {
            seed: this.seed,
            ...(this.sandbox ? { allowedCapabilities: SANDBOX_CAPABILITIES } : {}),
          }),
        );
      case "subagent":
        return withReasoning(
          subagentTurn(request, {
            seed: this.seed,
            canUse: (name) => this.canUse(name),
            disclaimer: this.disclaimer,
          }),
        );
      case "judge":
        return judgeTurn(request);
      case "web_search":
        return webSearchTurn(request);
      case "json":
        return jsonTurn(request);
      case "generic":
        return genericTurn(request);
    }
  }

  roleOf(request: BrainRequest): BrainRole {
    return detectRole(request);
  }

  /** Whether the built-in policies may call a tool (sandbox and `avoidTools`). */
  canUse(toolName: string): boolean {
    return !this.avoid.has(toolName) && (!this.sandbox || SANDBOX_TOOLS.has(toolName));
  }

  /** Answer matching requests with `turn` (checked in order, before the built-in policy). */
  when(match: BrainMatcher, turn: AssistantTurn | TurnFactory, options: RuleOptions = {}): this {
    this.rules.push({
      name: options.name ?? (typeof match === "string" ? match : `rule ${this.rules.length + 1}`),
      match,
      turn,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
    });
    return this;
  }

  /** Exact turns for the next requests (optionally only for one role), first in first out. */
  enqueue(...turns: AssistantTurn[]): this {
    for (const turn of turns) this.queue.push({ turn });
    return this;
  }

  enqueueFor(role: BrainRole, ...turns: AssistantTurn[]): this {
    for (const turn of turns) this.queue.push({ role, turn });
    return this;
  }

  /** The next matching requests fail like an unavailable model. */
  fail(options: FaultOptions & { message?: string; status?: number } = {}): this {
    this.failures.push({
      ...(options.role !== undefined ? { match: options.role } : {}),
      remaining: options.times ?? 1,
      turn: {
        error: {
          message: options.message ?? "The model is unavailable (fake failure).",
          ...(options.status !== undefined ? { status: options.status } : {}),
        },
      },
    });
    return this;
  }

  /** The next matching requests never get an answer (callers must time out or abort). */
  hang(options: FaultOptions = {}): this {
    this.failures.push({
      ...(options.role !== undefined ? { match: options.role } : {}),
      remaining: options.times ?? 1,
      turn: { hang: true },
    });
    return this;
  }

  /** Breaks the arguments of the next calls to `tool` the brain makes. */
  corruptToolArgs(options: { tool: string; mode?: ArgsCorruption; times?: number }): this {
    this.corruptions.push({
      tool: options.tool,
      mode: options.mode ?? "invalid-json",
      remaining: options.times ?? 1,
    });
    return this;
  }

  /** The next matching turn with tool calls calls a tool that doesn't exist instead. */
  unknownTool(options: FaultOptions = {}): this {
    this.unknownTools.push({
      ...(options.role !== undefined ? { match: options.role } : {}),
      remaining: options.times ?? 1,
    });
    return this;
  }

  /** Forgets rules, queued turns, faults and the decision log. */
  reset(): void {
    this.rules = [];
    this.queue = [];
    this.failures = [];
    this.corruptions = [];
    this.unknownTools = [];
    this.decisions.length = 0;
  }

  /** Deterministic token counts: characters / 4 of the prompt and of the completion. */
  usage(
    request: BrainRequest,
    turn: AssistantTurn,
  ): { promptTokens: number; completionTokens: number } {
    let prompt = request.system.length + JSON.stringify(request.tools).length;
    for (const message of request.messages) {
      prompt += message.content.length;
      if (message.role === "assistant") {
        for (const call of message.toolCalls) prompt += call.name.length + call.arguments.length;
      }
    }
    const completion =
      (turn.text?.length ?? 0) +
      (turn.reasoning?.length ?? 0) +
      (turn.toolCalls ? JSON.stringify(turn.toolCalls).length : 0);
    return { promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(completion) };
  }

  private choose(request: BrainRequest, info: TurnInfo): BrainDecision {
    const role = info.role;
    const failure = this.failures.find((f) => f.remaining > 0 && matches(f.match, request, info));
    if (failure) {
      failure.remaining--;
      return {
        role,
        source: "fault",
        label: failure.turn.hang ? "hang" : "fail",
        request,
        turn: failure.turn,
      };
    }
    const queued = this.queue.findIndex((q) => q.role === undefined || q.role === role);
    if (queued >= 0) {
      const [entry] = this.queue.splice(queued, 1);
      return this.postProcess({ role, source: "queue", request, turn: entry!.turn }, request, info);
    }
    for (const rule of this.rules) {
      if (rule.remaining <= 0 || !matches(rule.match, request, info)) continue;
      rule.remaining--;
      const turn = typeof rule.turn === "function" ? rule.turn(request, info) : rule.turn;
      return this.postProcess(
        { role, source: "rule", label: rule.name, request, turn },
        request,
        info,
      );
    }
    return this.postProcess(
      { role, source: "policy", request, turn: this.policy(request, role) },
      request,
      info,
    );
  }

  private postProcess(
    decision: BrainDecision,
    request: BrainRequest,
    info: TurnInfo,
  ): BrainDecision {
    const calls = decision.turn.toolCalls;
    if (!calls || calls.length === 0) return decision;
    let changed = false;
    let label = decision.label;
    const next: TurnToolCall[] = calls.map((call) => {
      const corruption = this.corruptions.find((c) => c.remaining > 0 && c.tool === call.name);
      if (!corruption) return call;
      corruption.remaining--;
      changed = true;
      label = `corrupt:${corruption.mode}`;
      return { ...call, arguments: corrupt(call.arguments, corruption.mode) };
    });
    const unknown = this.unknownTools.find(
      (u) => u.remaining > 0 && matches(u.match, request, info),
    );
    if (unknown) {
      unknown.remaining--;
      changed = true;
      label = "unknown-tool";
      next[0] = { ...next[0]!, name: "no_such_tool" };
    }
    if (!changed) return decision;
    return {
      ...decision,
      source: "fault",
      ...(label ? { label } : {}),
      turn: { ...decision.turn, toolCalls: next },
    };
  }
}

export function createFakeBrain(options: FakeBrainOptions = {}): FakeBrain {
  return new FakeBrain(options);
}

function matches(match: BrainMatcher | undefined, request: BrainRequest, info: TurnInfo): boolean {
  if (match === undefined) return true;
  return typeof match === "string" ? match === info.role : match(request, info);
}

function corrupt(args: unknown, mode: ArgsCorruption): unknown {
  const json = typeof args === "string" ? args : JSON.stringify(args ?? {});
  switch (mode) {
    case "invalid-json":
      return json.slice(0, Math.max(1, Math.floor(json.length / 2)));
    case "schema":
      return {};
    case "wrong-type": {
      const object =
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
      return Object.fromEntries(Object.keys(object).map((key) => [key, 12345]));
    }
  }
}

function withReasoning(turn: AssistantTurn): AssistantTurn {
  if (turn.reasoning || turn.error || turn.hang) return turn;
  const names = turn.toolCalls?.map((call) => call.name) ?? [];
  return {
    ...turn,
    reasoning: names.length > 0 ? `Next: ${names.join(", ")}.` : "Nothing left to do.",
  };
}

/**
 * The safety evaluator: most-restrictive-wins over policy lists, hard-deny rules, tool hints,
 * approval rules, the read-only fast path and (for actions the rules cannot classify) the LLM
 * judge, then the category policy. It never throws: internal errors yield `require_approval`.
 */
import type { ActionCategory, RiskLevel, SafetyDecision } from "@ddl/core";
import { silentLogger } from "@ddl/core";
import { type ActionAnalysis, analyzeAction } from "./analyze";
import { describeAction, redactActionInput } from "./describe";
import { createLlmJudge, type LlmJudge } from "./llm-judge";
import { maxRisk, resolvePolicy, riskRank, stricterDecision } from "./policy";
import type { RuleHit } from "./rules/types";
import type {
  ActionContext,
  SafetyEvaluator,
  SafetyEvaluatorOptions,
  SafetyPolicy,
  SafetyVerdict,
  VerdictSource,
} from "./types";

type Draft = Omit<SafetyVerdict, "latencyMs" | "summary">;

const DECISION_FLOOR_RISK: Record<SafetyDecision, RiskLevel> = {
  allow: "low",
  require_approval: "medium",
  deny: "high",
};

function orderedCategories(...lists: ReadonlyArray<readonly ActionCategory[]>): ActionCategory[] {
  const out = new Set<ActionCategory>();
  for (const list of lists) for (const c of list) out.add(c);
  return [...out];
}

function hitRisk(hit: RuleHit): RiskLevel {
  return hit.risk ?? hit.rule.risk;
}

function reasonFrom(hits: readonly RuleHit[]): string {
  const sorted = [...hits].sort((a, b) => riskRank(hitRisk(b)) - riskRank(hitRisk(a)));
  const parts: string[] = [];
  for (const hit of sorted) {
    const text = `${hit.rule.description} (${hit.evidence})`;
    if (!parts.includes(text)) parts.push(text);
    if (parts.length === 3) break;
  }
  return parts.join("; ");
}

/** Rule ids behind the verdict: the risky ones when any fired, otherwise the benign classifiers. */
function matched(hits: readonly RuleHit[]): string[] {
  const risky = hits.filter((h) => h.rule.decision !== "allow");
  return [...new Set((risky.length > 0 ? risky : hits).map((h) => h.rule.id))];
}

function ruleCategories(hits: readonly RuleHit[]): ActionCategory[] {
  const risky = hits.filter((h) => h.rule.decision !== "allow").map((h) => h.rule.category);
  return risky.length > 0 ? risky : hits.map((h) => h.rule.category);
}

export interface EvaluatorInternals {
  policy: SafetyPolicy;
  judge?: LlmJudge;
}

async function decide(
  ctx: ActionContext,
  analysis: ActionAnalysis,
  internals: EvaluatorInternals,
  summary: string,
  signal?: AbortSignal,
): Promise<Draft> {
  const { policy, judge } = internals;
  const { hits, hintCategories } = analysis;
  const tool = ctx.toolName;
  const denyHits = hits.filter((h) => h.rule.decision === "deny");
  const approvalHits = hits.filter((h) => h.rule.decision === "require_approval");
  const categories = orderedCategories(ruleCategories(hits), hintCategories);
  const risk = maxRisk(...hits.filter((h) => h.rule.decision !== "allow").map(hitRisk));
  const matchedRules = matched(hits);

  if (policy.alwaysDenyTools.includes(tool)) {
    return {
      decision: "deny",
      risk: maxRisk(risk, "high"),
      categories,
      reason: `${tool} is blocked by your safety policy.`,
      source: "policy",
      matchedRules,
    };
  }
  if (denyHits.length > 0) {
    return {
      decision: "deny",
      risk: maxRisk(risk, "critical"),
      categories,
      reason: reasonFrom(denyHits),
      source: "rules",
      matchedRules,
    };
  }
  const deniedCategory = categories.find((c) => policy.denyCategories.includes(c));
  if (deniedCategory) {
    return {
      decision: "deny",
      risk: maxRisk(risk, "high"),
      categories,
      reason: `Actions in the “${deniedCategory}” category are blocked by your safety policy.`,
      source: "policy",
      matchedRules,
    };
  }
  if (policy.alwaysAllowTools.includes(tool)) {
    return {
      decision: "allow",
      risk,
      categories,
      reason: `${tool} is always allowed by your safety policy.`,
      source: "policy",
      matchedRules,
    };
  }

  let decision: SafetyDecision = "allow";
  let source: VerdictSource = "rules";
  let verdictRisk = risk;
  let finalCategories = categories;
  const reasons: string[] = [];

  if (policy.requireApprovalTools.includes(tool)) {
    decision = "require_approval";
    source = "policy";
    reasons.push(`${tool} always needs your approval.`);
  }
  if (ctx.hints?.alwaysRequireApproval) {
    decision = "require_approval";
    source = "policy";
    reasons.push("This tool always asks for approval.");
  }

  if (approvalHits.length > 0) {
    decision = "require_approval";
    if (reasons.length === 0) source = "rules";
    reasons.unshift(reasonFrom(approvalHits));
  } else if (analysis.uncertainties.length > 0 && !analysis.fastPath) {
    if (judge) {
      const verdict = await judge.judge(
        {
          ctx,
          summary,
          input: redactActionInput(ctx, analysis.facts),
          signals: [
            ...analysis.uncertainties,
            ...(categories.length ? [`categories: ${categories.join(", ")}`] : []),
          ],
        },
        signal,
      );
      // The judge can only make the decision stricter than the policy floors computed above.
      const judged = stricterDecision(decision, verdict.decision);
      if (judged !== decision || source !== "policy") source = verdict.source;
      decision = judged;
      verdictRisk = maxRisk(verdictRisk, verdict.risk);
      finalCategories = orderedCategories(
        finalCategories,
        verdict.categories.filter((c) => c !== "unknown" || verdict.source === "fallback"),
      );
      reasons.push(verdict.reason);
    } else if (
      ctx.hints?.readOnly ||
      analysis.facts.family === "browser" ||
      (analysis.facts.family === "mcp" && analysis.facts.ui?.surface === "browser")
    ) {
      reasons.push("No risk signals found.");
    } else {
      decision = "require_approval";
      if (source !== "policy") source = "fallback";
      reasons.push(
        `Couldn't verify this action automatically (${analysis.uncertainties.slice(0, 2).join("; ")}).`,
      );
      if (finalCategories.length === 0) finalCategories = ["unknown"];
    }
  }

  const approvalCategory = finalCategories.find((c) => policy.approvalCategories.includes(c));
  if (decision === "allow" && approvalCategory) {
    decision = "require_approval";
    source = "policy";
    reasons.unshift(`Actions in the “${approvalCategory}” category need your approval.`);
  }
  const deniedLate = finalCategories.find((c) => policy.denyCategories.includes(c));
  if (deniedLate) {
    return {
      decision: "deny",
      risk: maxRisk(verdictRisk, "high"),
      categories: finalCategories,
      reason: `Actions in the “${deniedLate}” category are blocked by your safety policy.`,
      source: "policy",
      matchedRules,
    };
  }

  if (decision === "allow" && reasons.length === 0) {
    const benign = hits.filter((h) => h.rule.decision === "allow");
    reasons.push(
      benign.length > 0
        ? reasonFrom(benign)
        : analysis.fastPath
          ? "Read-only or internal action."
          : "No risk signals found.",
    );
  }
  return {
    decision,
    risk: maxRisk(verdictRisk, DECISION_FLOOR_RISK[decision]),
    categories: finalCategories,
    reason: reasons.join(" "),
    source,
    matchedRules,
  };
}

export function fallbackVerdict(
  ctx: ActionContext,
  reason: string,
  latencyMs: number,
): SafetyVerdict {
  let summary = ctx.toolName;
  try {
    summary = describeAction(ctx);
  } catch {
    // Keep the tool name as the summary.
  }
  return {
    decision: "require_approval",
    risk: "medium",
    categories: ["unknown"],
    reason,
    summary,
    source: "fallback",
    latencyMs,
  };
}

export function createSafetyEvaluator(options: SafetyEvaluatorOptions = {}): SafetyEvaluator {
  const logger = options.logger ?? silentLogger;
  const policy = resolvePolicy(options.policy);
  const internals: EvaluatorInternals = {
    policy,
    ...(policy.llmJudge && options.llm
      ? {
          judge: createLlmJudge({
            llm: options.llm,
            ...(options.judgeModel ? { model: options.judgeModel } : {}),
            timeoutMs: policy.llmJudgeTimeoutMs,
            logger,
          }),
        }
      : {}),
  };
  return {
    async evaluate(ctx, signal) {
      const started = performance.now();
      try {
        const analysis = analyzeAction(ctx);
        const summary = describeAction(ctx, analysis.facts);
        const draft = await decide(ctx, analysis, internals, summary, signal);
        return { ...draft, summary, latencyMs: performance.now() - started };
      } catch (error) {
        logger.error("safety evaluation failed", {
          tool: ctx.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
        return fallbackVerdict(
          ctx,
          "The safety check failed internally, so this needs your approval.",
          performance.now() - started,
        );
      }
    },
  };
}

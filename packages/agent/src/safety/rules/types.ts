import type { ActionCategory, RiskLevel } from "@ddl/core";
import type { ActionFacts } from "../facts";
import type { ResolvedPath } from "../paths";
import type { ShellAnalysis, ShellCommand } from "../shell";

/** What a rule decides when it fires. `allow` rules only mark an action as recognized-benign. */
export type RuleDecision = "allow" | "require_approval" | "deny";

/** Static description of a rule (exported as `SAFETY_RULES` for docs, UIs and evals). */
export interface SafetyRuleInfo {
  readonly id: string;
  readonly category: ActionCategory;
  readonly decision: RuleDecision;
  readonly risk: RiskLevel;
  /** What the rule matches, phrased for people ("Completes a purchase or payment"). */
  readonly description: string;
}

export interface RuleHit {
  readonly rule: SafetyRuleInfo;
  /** The concrete thing that matched, e.g. `“Place order”` or `rm -rf ~`. */
  readonly evidence: string;
  /** Overrides the rule's risk for this hit (e.g. deleting a whole home subfolder is critical). */
  readonly risk?: RiskLevel;
}

/** Evidence string when the rule fires; `null`/`undefined` when it does not. */
export type Match = string | { evidence: string; risk: RiskLevel } | null | undefined;

export interface ActionRule extends SafetyRuleInfo {
  match(facts: ActionFacts): Match;
}

export interface ShellEnv {
  readonly analysis: ShellAnalysis;
  readonly workspaceDir?: string;
  readonly home?: string;
  resolve(raw: string, cmd: ShellCommand): ResolvedPath;
}

export interface ShellRule extends SafetyRuleInfo {
  match(cmd: ShellCommand, env: ShellEnv): Match;
}

export function info(
  id: string,
  category: ActionCategory,
  decision: RuleDecision,
  risk: RiskLevel,
  description: string,
): SafetyRuleInfo {
  return { id, category, decision, risk, description };
}

export function hitOf(rule: SafetyRuleInfo, match: Match): RuleHit | undefined {
  if (match === null || match === undefined || match === "") return undefined;
  return typeof match === "string"
    ? { rule, evidence: match }
    : { rule, evidence: match.evidence, risk: match.risk };
}

/** Runs rules, collecting at most one hit per rule. */
export function runRules<T extends SafetyRuleInfo, A extends unknown[]>(
  rules: readonly (T & { match(...args: A): Match })[],
  ...args: A
): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    const hit = hitOf(rule, rule.match(...args));
    if (hit) hits.push(hit);
  }
  return hits;
}

export function quote(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

/**
 * Runs the rules that apply to one action and reports what they found: rule hits (risky and
 * benign), whether the action is on the read-only fast path, and what could not be classified.
 * It never decides; the evaluator combines this with policy, hints and the LLM judge.
 */
import type { ActionCategory } from "@ddl/core";
import { type ActionFacts, buildFacts, COMPUTER_READ_RE, withSubject } from "./facts";
import { type Cwd, inferHome, resolvePath } from "./paths";
import { ACTION_CATEGORIES } from "./policy";
import { searchQueryHits, sensitiveValueHits, sqlHits, writtenContentHits } from "./rules/content";
import { fileReadAnalysis, fileWriteAnalysis, NOTES_READ } from "./rules/files";
import { mcpAnalysis } from "./rules/mcp";
import { noteEditHits } from "./rules/notes";
import { readPathHits, writePathHits } from "./rules/path-rules";
import { analysisHits, commandHits, SHELL_BENIGN } from "./rules/shell";
import { quote, type RuleHit, runRules, type ShellEnv } from "./rules/types";
import { benignUiHit, typedTextHits, UI_RULES } from "./rules/ui";
import { asWebUrl, urlHits, WEB_READ, WEB_SEARCH } from "./rules/web";
import { classifyCommand, redirectRole } from "./shell-commands";
import type { ActionContext } from "./types";

export interface ActionAnalysis {
  facts: ActionFacts;
  hits: RuleHit[];
  /** Read-only or internal: allowed without the judge unless a risky rule fires. */
  fastPath: boolean;
  /**
   * Changes something: everything off the fast path, plus the two writes on it (the agent's own
   * note edits and connector drafts). What `ask_every_action` asks before.
   */
  effectful: boolean;
  /** Why the action could not be classified; empty when rules recognized it. */
  uncertainties: string[];
  /** Categories implied by the tool's own hints (never used to allow anything). */
  hintCategories: ActionCategory[];
}

interface FamilyResult {
  hits: RuleHit[];
  uncertainties: string[];
}

export function isRisky(hits: readonly RuleHit[]): boolean {
  return hits.some((h) => h.rule.decision !== "allow");
}

function dedupe(hits: RuleHit[]): RuleHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.rule.id}\u0000${h.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function webUrlHits(urls: readonly string[]): RuleHit[] {
  const hits = urls.flatMap((u) => urlHits(u));
  const web = urls.find((u) => /^https?:\/\//i.test(asWebUrl(u)));
  if (!isRisky(hits) && web) hits.push({ rule: WEB_READ, evidence: web.slice(0, 120) });
  return hits;
}

function uiAnalysis(f: ActionFacts): FamilyResult {
  if (f.ui?.action === "navigate") {
    const hits = webUrlHits(f.urls);
    return { hits, uncertainties: hits.length === 0 ? ["navigation without a web URL"] : [] };
  }
  const hits = [...runRules(UI_RULES, f), ...typedTextHits(f)];
  const benign = benignUiHit(f);
  if (benign) hits.push(benign);
  const target = f.elementLabel ? ` on ${quote(f.elementLabel)}` : "";
  return {
    hits,
    uncertainties:
      hits.length === 0 ? [`unrecognized ${f.ui?.action ?? "interaction"}${target}`] : [],
  };
}

function shellAnalysis(f: ActionFacts): FamilyResult {
  const analysis = f.shell;
  if (!analysis) return { hits: [], uncertainties: ["no shell command given"] };
  const { workspaceDir, appHome } = f.ctx;
  const home = inferHome(workspaceDir);
  const env: ShellEnv = {
    analysis,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(home ? { home } : {}),
    resolve: (raw: string, cmd: { cwd: Cwd }) => resolvePath(raw, cmd.cwd, workspaceDir, appHome),
  };
  const hits: RuleHit[] = [...analysisHits(env)];
  const uncertainties: string[] = [];
  const benign = new Set<keyof typeof SHELL_BENIGN>();
  for (const cmd of analysis.commands) {
    const cmdHits = commandHits(cmd, env);
    hits.push(...cmdHits);
    if (isRisky(cmdHits)) continue;
    const { kind, note } = classifyCommand(cmd);
    if (kind === "read" || kind === "network") benign.add("read");
    else if (kind === "compute") benign.add("compute");
    else if (kind === "workspace-write") benign.add("file_write");
    else if (kind !== "noop") uncertainties.push(note ?? `\`${cmd.name}\``);
    if (cmd.redirects.some((r) => redirectRole(r) === "write")) benign.add("file_write");
  }
  if (uncertainties.length === 0 && !isRisky(hits)) {
    if (benign.size === 0) benign.add("compute");
    for (const kind of benign)
      hits.push({ rule: SHELL_BENIGN[kind], evidence: quote(analysis.source, 80) });
  }
  return { hits, uncertainties };
}

function contentHits(f: ActionFacts, effectful: boolean): RuleHit[] {
  const hits = [...sensitiveValueHits(f.strings), ...sqlHits(f.strings, f.ctx.toolName)];
  if (effectful) for (const text of f.strings) hits.push(...writtenContentHits(text));
  return hits;
}

function connectorAnalysis(f: ActionFacts): FamilyResult {
  if (f.ui) return uiAnalysis(f);
  const mcp = mcpAnalysis(f);
  const hits: RuleHit[] = [...mcp.hits];
  for (const url of f.urls) hits.push(...urlHits(url));
  // Connector servers resolve relative paths against their own roots, which we cannot see.
  for (const raw of f.paths) {
    const target = resolvePath(raw, { kind: "unknown" }, f.ctx.workspaceDir, f.ctx.appHome);
    hits.push(...(mcp.readOnly ? readPathHits(target, raw) : writePathHits(target, raw)));
  }
  if (f.shell) hits.push(...shellAnalysis(f).hits.filter((h) => h.rule.decision !== "allow"));
  hits.push(...contentHits(f, mcp.effectful));
  if (mcp.benign && !isRisky(hits)) hits.push(mcp.benign);
  const uncertainties =
    hits.length === 0
      ? [`connector tool ${quote(f.ctx.toolName)} with an effect the rules cannot classify`]
      : [];
  return { hits, uncertainties };
}

export function analyzeAction(ctx: ActionContext): ActionAnalysis {
  const modelFacts = buildFacts(ctx);
  // What the tool knows about the real target joins the model's words; its rule hits may only add
  // risk, so everything else below comes from the model's own facts.
  const facts = withSubject(modelFacts);
  const subjectHits =
    facts === modelFacts || !facts.ui
      ? []
      : uiAnalysis(facts).hits.filter((hit) => hit.rule.decision !== "allow");
  const hints = ctx.hints ?? {};
  const { result, fastPath } = familyAnalysis(modelFacts, ctx, hints.readOnly === true);
  const hits = [...result.hits, ...subjectHits];

  const hintCategories: ActionCategory[] = [];
  if (
    (facts.family === "mcp" || facts.family === "custom") &&
    ACTION_CATEGORIES.includes(hints.category as ActionCategory)
  )
    hintCategories.push(hints.category as ActionCategory);
  if (hints.destructive && facts.family !== "internal" && facts.family !== "knowledge")
    hintCategories.push("destructive");

  const writesOnFastPath =
    modelFacts.family === "note_edit" || hits.some((h) => h.rule.id === "mcp.draft");
  return {
    facts,
    hits: dedupe(hits),
    fastPath,
    effectful: !fastPath || writesOnFastPath,
    uncertainties: isRisky(hits) ? [] : result.uncertainties,
    hintCategories,
  };
}

function familyAnalysis(
  f: ActionFacts,
  ctx: ActionContext,
  readOnly: boolean,
): { result: FamilyResult; fastPath: boolean } {
  let result: FamilyResult = { hits: [], uncertainties: [] };
  let fastPath = readOnly;
  switch (f.family) {
    case "internal":
      fastPath = true;
      break;
    case "knowledge":
      fastPath = true;
      result.hits = [{ rule: NOTES_READ, evidence: f.operation }];
      break;
    case "web_search": {
      fastPath = true;
      const query = typeof f.input.query === "string" ? f.input.query : "";
      const hits = searchQueryHits(query);
      result.hits = hits.length > 0 ? hits : [{ rule: WEB_SEARCH, evidence: quote(query) }];
      break;
    }
    case "web_fetch":
      fastPath = true;
      result.hits = webUrlHits(f.urls);
      break;
    case "browser":
      fastPath ||=
        f.ui?.action === "navigate" || f.ui?.action === "read" || f.ui?.action === "hover";
      result = uiAnalysis(f);
      break;
    case "computer":
      fastPath = COMPUTER_READ_RE.test(f.operation);
      result = uiAnalysis(f);
      break;
    case "shell":
      result = shellAnalysis(f);
      break;
    case "file_read": {
      fastPath = true;
      const r = fileReadAnalysis(f);
      result.hits = r.benign ? [...r.hits, r.benign] : r.hits;
      break;
    }
    case "file_write": {
      const r = fileWriteAnalysis(f);
      result.hits = r.benign ? [...r.hits, r.benign] : r.hits;
      break;
    }
    case "note_edit":
      result.hits = noteEditHits(f.input);
      fastPath = result.hits.every((hit) => hit.rule.decision === "allow");
      break;
    case "mcp":
      result = connectorAnalysis(f);
      fastPath ||= result.hits.some(
        (h) => h.rule.id === "mcp.read-action" || h.rule.id === "mcp.draft",
      );
      break;
    case "custom":
      result.hits = contentHits(f, !readOnly);
      if (result.hits.length === 0)
        result.uncertainties.push(`tool ${quote(ctx.toolName)} has no specific safety rules`);
      break;
  }
  return { result, fastPath };
}

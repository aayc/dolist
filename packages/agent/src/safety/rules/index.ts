import { CONTENT_RULES } from "./content";
import { FILES_READ, FILES_WORKSPACE_WRITE, NOTES_READ, SECRET_SEARCH } from "./files";
import { MCP_RULES } from "./mcp";
import { NOTE_EDIT_RULES } from "./notes";
import { PATH_RULES } from "./path-rules";
import {
  SHELL_BENIGN,
  SHELL_FORK_BOMB,
  SHELL_RULES,
  SHELL_TOO_LARGE,
  SHELL_UNPARSEABLE,
} from "./shell";
import type { SafetyRuleInfo } from "./types";
import { BENIGN_UI, UI_RULES } from "./ui";
import { URL_RULES, WEB_READ, WEB_SEARCH } from "./web";

export type { RuleDecision, SafetyRuleInfo } from "./types";

function metadata(rules: readonly SafetyRuleInfo[]): SafetyRuleInfo[] {
  const byId = new Map<string, SafetyRuleInfo>();
  for (const { id, category, decision, risk, description } of rules) {
    if (!byId.has(id)) byId.set(id, Object.freeze({ id, category, decision, risk, description }));
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Every rule the evaluator can match, for docs, settings UIs and evals (sorted by id). */
export const SAFETY_RULES: readonly SafetyRuleInfo[] = Object.freeze(
  metadata([
    ...SHELL_RULES,
    SHELL_TOO_LARGE,
    SHELL_FORK_BOMB,
    SHELL_UNPARSEABLE,
    ...Object.values(SHELL_BENIGN),
    ...PATH_RULES,
    ...CONTENT_RULES,
    ...URL_RULES,
    WEB_READ,
    WEB_SEARCH,
    ...UI_RULES,
    ...Object.values(BENIGN_UI),
    ...MCP_RULES,
    FILES_READ,
    NOTES_READ,
    ...NOTE_EDIT_RULES,
    FILES_WORKSPACE_WRITE,
    SECRET_SEARCH,
  ]),
);

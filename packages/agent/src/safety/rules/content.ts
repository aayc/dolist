/**
 * Adapted from Hermes Agent (MIT) — see NOTICE.md for the adapted patterns and license.
 *
 * Text scanners shared across tools: catastrophic shell snippets and secret-store access inside
 * code or typed text, destructive SQL, money-transfer wording, and sensitive values (cards,
 * secrets, SSNs) leaving the machine in tool arguments.
 */
import { findCardNumbers, findSecrets, findSsns } from "../sensitive";
import { MONEY_TRANSFER_TEXT } from "../vocab";
import { APP_CONFIG_WRITE } from "./path-rules";
import { info, quote, type RuleHit, type SafetyRuleInfo } from "./types";

interface TextPattern {
  re: RegExp;
  label: string;
}

const SYSTEM_DIR_ALT =
  "home|root|etc|usr|var|bin|sbin|boot|lib|lib64|opt|private|System|Library|Applications|Users|Volumes|dev";

/**
 * Catastrophic commands spotted inside code, heredocs or typed text (adapted from Hermes Agent's
 * HARDLINE patterns, with the command-position anchor relaxed to also accept quotes and parens).
 */
const HARDLINE_TEXT: readonly TextPattern[] = [
  {
    re: new RegExp(
      `(?:^|[\\s'"\`;|&(])rm\\s+(?:-[a-zA-Z-]+\\s+)*["']?(?:/(?:\\*|\\.\\.?)?|~/?\\*?|\\$HOME/?\\*?|\\$\\{HOME\\}/?\\*?|/(?:${SYSTEM_DIR_ALT})(?:/\\*?)?)["']?(?=$|[\\s'";|&)\`])`,
      "i",
    ),
    label: "recursive delete of a root, system or home directory",
  },
  { re: /(?:^|[\s'"`;|&(])mkfs(?:\.[a-z0-9]+)?\b/i, label: "format filesystem (mkfs)" },
  {
    re: /\bdiskutil\s+(?:eraseDisk|eraseVolume|zeroDisk|randomDisk|secureErase|partitionDisk|reformat)\b/i,
    label: "erase disk (diskutil)",
  },
  {
    re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)[a-z0-9]*/i,
    label: "dd to raw block device",
  },
  {
    re: />\s*\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)[a-z0-9]*\b/i,
    label: "redirect to raw block device",
  },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, label: "fork bomb" },
  { re: /\b(\w+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1\b/, label: "fork bomb" },
  { re: /\bkill\s+(?:-[A-Za-z0-9]+\s+)*-1(?![\d])/, label: "kill all processes" },
];

/** Reading private keys, keychains and credential stores, spotted anywhere in text. */
const SECRET_ACCESS_TEXT: readonly TextPattern[] = [
  {
    re: /\.ssh\/(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|identity)\b(?!\.pub)/i,
    label: "private SSH key",
  },
  {
    re: /\bsecurity\s+(?:find-(?:generic|internet)-password\b[^\n]*\s-[a-zA-Z]*[wg]\b|dump-keychain\b|export\b[^\n]*-t\s+(?:identities|privKeys|all))/i,
    label: "keychain password dump",
  },
  {
    re: /\.aws\/credentials\b|\.git-credentials\b|\/\.netrc\b|Library\/Keychains\b|\/Login Data\b|\.gnupg\/private-keys|\.config\/gh\/hosts\.yml|\.daily-do-list\/\.env\b/i,
    label: "credential store",
  },
  { re: /\bgpg2?\s+[^\n]*--export-secret-(?:keys|subkeys)\b/i, label: "GPG secret key export" },
];

const REMOTE_EXEC_TEXT: readonly TextPattern[] = [
  {
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ksh|python3?|node|perl|ruby)\b/i,
    label: "downloaded script piped to an interpreter",
  },
  {
    re: /\b(?:bash|sh|zsh)\s+<\(\s*(?:curl|wget)\b/i,
    label: "downloaded script run via process substitution",
  },
];

const DESTRUCTIVE_SQL: readonly TextPattern[] = [
  { re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|USER|ROLE|COLLECTION)\b/i, label: "DROP" },
  { re: /\bTRUNCATE\s+(?:TABLE\s+)?[\w."`]+/i, label: "TRUNCATE" },
  { re: /\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)/i, label: "DELETE without WHERE" },
  { re: /\bALTER\s+TABLE\b[^;\n]*\bDROP\b/i, label: "ALTER TABLE … DROP" },
  {
    re: /\bFLUSH(?:ALL|DB)\b|\.dropDatabase\(\s*\)|\.drop\(\s*\)|\bdeleteMany\(\s*\{\s*\}\s*\)/,
    label: "drop/flush",
  },
];

function firstMatch(
  patterns: readonly TextPattern[],
  text: string,
): { label: string; snippet: string } | undefined {
  for (const { re, label } of patterns) {
    const m = re.exec(text);
    if (m) return { label, snippet: m[0].trim() };
  }
  return undefined;
}

export function hardlineInText(text: string): { label: string; snippet: string } | undefined {
  return firstMatch(HARDLINE_TEXT, text);
}

export function secretAccessInText(text: string): { label: string; snippet: string } | undefined {
  return firstMatch(SECRET_ACCESS_TEXT, text);
}

export function remoteExecInText(text: string): { label: string; snippet: string } | undefined {
  return firstMatch(REMOTE_EXEC_TEXT, text);
}

export function destructiveSqlInText(text: string): { label: string; snippet: string } | undefined {
  return firstMatch(DESTRUCTIVE_SQL, text);
}

export function moneyTransferInText(text: string): string | undefined {
  for (const re of MONEY_TRANSFER_TEXT) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

export const EMBEDDED_HARDLINE = info(
  "shell.hardline.embedded",
  "destructive",
  "deny",
  "critical",
  "Runs a catastrophic command hidden inside code or typed text",
);
export const EMBEDDED_SECRET = info(
  "secrets.embedded-access",
  "credentials",
  "deny",
  "critical",
  "Reads private keys, keychains or credential stores from code or typed text",
);
export const CODE_HAZARD_WRITE = info(
  "system.code-hazard-write",
  "system",
  "require_approval",
  "high",
  "Writes a script that deletes system data, reads secrets or runs downloaded code",
);
export const DESTRUCTIVE_SQL_RULE = info(
  "destructive.sql",
  "destructive",
  "require_approval",
  "high",
  "Runs destructive SQL (DROP, TRUNCATE, DELETE without WHERE)",
);
export const MONEY_TRANSFER_RULE = info(
  "payment.transfer-text",
  "payment",
  "require_approval",
  "high",
  "Text asks to send money, gift cards or crypto",
);
export const CARD_NUMBER_RULE = info(
  "payment.card-number",
  "payment",
  "require_approval",
  "critical",
  "Enters or sends a payment card number",
);
export const SECRET_VALUE_RULE = info(
  "credentials.secret-value",
  "credentials",
  "require_approval",
  "high",
  "Enters or sends a password, API key or other secret",
);
export const SSN_VALUE_RULE = info(
  "privacy.id-number",
  "privacy",
  "require_approval",
  "high",
  "Enters or sends a social security number",
);

/**
 * The app's own folder (a vault's `.daily-do-list/` sidecar, or the default `$DDL_HOME`) named in
 * text, other than the agents' workspaces inside it.
 */
const APP_STATE_TEXT_RE = /\.daily-do-list(?![\w-])(?!\/workspaces\b)/i;

/**
 * Code that names the app's own settings or state, run now or staged to run later: code the agent
 * runs could otherwise change the approval policy or grants. Paths built at runtime aren't seen.
 */
export function appStateInCodeHits(text: string, where: string): RuleHit[] {
  const m = APP_STATE_TEXT_RE.exec(text);
  if (!m) return [];
  const snippet = text.slice(Math.max(0, m.index - 20), m.index + 40);
  return [
    { rule: APP_CONFIG_WRITE, evidence: `the app's own files in ${where}: ${quote(snippet)}` },
  ];
}

/**
 * Code or typed text that will run: catastrophic snippets, secret access and the app's own files
 * are hard denies.
 */
export function executedTextHits(text: string, where: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const hardline = hardlineInText(text);
  if (hardline)
    hits.push({
      rule: EMBEDDED_HARDLINE,
      evidence: `${hardline.label} in ${where}: ${quote(hardline.snippet)}`,
    });
  const secret = secretAccessInText(text);
  if (secret) hits.push({ rule: EMBEDDED_SECRET, evidence: `${secret.label} in ${where}` });
  hits.push(...appStateInCodeHits(text, where));
  return hits;
}

/** Content being written for later: dangerous snippets need a human look before they are staged. */
export function writtenContentHits(text: string): RuleHit[] {
  const hazard = hardlineInText(text) ?? secretAccessInText(text) ?? remoteExecInText(text);
  return hazard
    ? [{ rule: CODE_HAZARD_WRITE, evidence: `${hazard.label}: ${quote(hazard.snippet)}` }]
    : [];
}

/** Sensitive values in data that leaves the machine (MCP arguments, typed text, messages). */
export function sensitiveValueHits(texts: readonly string[]): RuleHit[] {
  const hits: RuleHit[] = [];
  const seen = new Set<SafetyRuleInfo>();
  const push = (rule: SafetyRuleInfo, evidence: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    hits.push({ rule, evidence });
  };
  for (const text of texts) {
    const card = findCardNumbers(text)[0];
    if (card) push(CARD_NUMBER_RULE, "card number (hidden)");
    const secret = findSecrets(text)[0];
    if (secret) push(SECRET_VALUE_RULE, `${secret.label} (hidden)`);
    if (findSsns(text).length > 0) push(SSN_VALUE_RULE, "SSN (hidden)");
    const transfer = moneyTransferInText(text);
    if (transfer) push(MONEY_TRANSFER_RULE, quote(transfer));
  }
  return hits;
}

/** A web search query leaves the machine: card numbers, secrets and SSNs must not ride along. */
export function searchQueryHits(query: string): RuleHit[] {
  const hits: RuleHit[] = [];
  if (findCardNumbers(query).length > 0)
    hits.push({ rule: CARD_NUMBER_RULE, evidence: "card number in a search query" });
  if (findSecrets(query).length > 0)
    hits.push({ rule: SECRET_VALUE_RULE, evidence: "secret in a search query" });
  if (findSsns(query).length > 0)
    hits.push({ rule: SSN_VALUE_RULE, evidence: "SSN in a search query" });
  return hits;
}

/** Destructive SQL anywhere in a connector's arguments (database MCP servers). */
export function sqlHits(texts: readonly string[], toolName: string): RuleHit[] {
  for (const text of texts) {
    const sql = destructiveSqlInText(text);
    if (sql) return [{ rule: DESTRUCTIVE_SQL_RULE, evidence: `${sql.label} via ${toolName}` }];
  }
  return [];
}

export const CONTENT_RULES: readonly SafetyRuleInfo[] = [
  EMBEDDED_HARDLINE,
  EMBEDDED_SECRET,
  CODE_HAZARD_WRITE,
  DESTRUCTIVE_SQL_RULE,
  MONEY_TRANSFER_RULE,
  CARD_NUMBER_RULE,
  SECRET_VALUE_RULE,
  SSN_VALUE_RULE,
];

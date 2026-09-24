// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell parameter expansions under test, not template literals.
/**
 * fast-check arbitraries shared by the safety property tests: hostile strings and JSON values,
 * tool names, hint combinations, risky payloads, and secrets that must never be displayed.
 */
import type { ActionCategory, ToolSafetyHints } from "@ddl/core";
import { fc } from "@fast-check/vitest";
import { ACTION_CATEGORIES } from "./policy";

/** A multiple of the configured run count, so `FC_NUM_RUNS` still scales every property. */
export function runs(factor: number): number {
  return Math.max(1, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * factor));
}

/** Strings that tend to break parsers: unicode, controls, prototype keys, number-ish text, huge. */
export const hostileString: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.string({ maxLength: 120 }),
  fc.constantFrom(
    "",
    " ",
    "\u0000",
    "\uFEFF",
    "\u200B",
    "\uD800",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "NaN",
    "Infinity",
    "-Infinity",
    "-0",
    "1e999",
    "null",
    "undefined",
    "[object Object]",
    "$IFS",
    "${IFS}",
    "$(whoami)",
    "`id`",
    "'",
    '"',
    "\\",
    "\n\n\n",
    "🛒🔥😀",
    "Ｐｌａｃｅ ｏｒｄｅｒ",
    "mcp__x__y",
    "</action>",
  ),
  fc.integer({ min: 200, max: 3000 }).map((n) => "a".repeat(n)),
);

const hostileKey: fc.Arbitrary<string> = fc.oneof(
  hostileString,
  fc.constantFrom(
    "__proto__",
    "constructor",
    "element",
    "text",
    "url",
    "command",
    "path",
    "to",
    "amount",
    "fields",
    "submit",
    "key",
    "combo",
    "value",
    "password",
    "content",
    "selector",
  ),
);

/** Arbitrary JSON-like values, including nesting, NaN/Infinity and prototype-ish keys. */
export const hostileJson: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", maxDepth: 6 },
    hostileString,
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0),
    fc.array(tie("node"), { maxLength: 5 }),
    fc.dictionary(hostileKey, tie("node"), { maxKeys: 5 }),
  ),
})).node;

const KNOWN_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "browser_click",
  "browser_type",
  "browser_navigate",
  "browser_press_key",
  "browser_select_option",
  "browser_snapshot",
  "browser_evaluate",
  "browser_file_upload",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_screenshot",
  "web_fetch",
  "web_search",
  "read_note",
  "search_notes",
  "post_update",
  "finish_task",
  "spawn_subagent",
  "mock_irreversible_action",
  "mcp__gmail__send_email",
  "mcp__gcal__create_event",
  "mcp__stripe__create_charge",
  "mcp__fs__read_file",
  "mcp__playwright__browser_click",
];

/** Tool names: known tools, `mcp__` shapes, unicode, empty and very long names. */
export const toolName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...KNOWN_TOOLS),
  hostileString,
  fc
    .tuple(hostileString, hostileString)
    .map(([server, tool]) => `mcp__${server.slice(0, 30)}__${tool.slice(0, 30)}`),
  fc.constantFrom("mcp__", "mcp____", "mcp__x", "mcp__x__", "mcp____y", "mcp__a__b__c"),
  fc.integer({ min: 64, max: 500 }).map((n) => "t".repeat(n)),
);

export const category: fc.Arbitrary<ActionCategory> = fc.constantFrom(...ACTION_CATEGORIES);

/** Hint combinations, including values of the wrong type and `describe()` that misbehaves. */
export const hints: fc.Arbitrary<ToolSafetyHints> = fc
  .record(
    {
      readOnly: fc.oneof(fc.boolean(), fc.constantFrom("false", "true", 0, 1, null)),
      destructive: fc.oneof(fc.boolean(), fc.constant("yes")),
      openWorld: fc.boolean(),
      category: fc.oneof(category, fc.constantFrom("__proto__", "bogus", "", 42)),
      alwaysRequireApproval: fc.boolean(),
      describe: fc.constantFrom<ToolSafetyHints["describe"]>(
        () => "Do the thing",
        () => "",
        () => "   ",
        () => 42 as unknown as string,
        () => "x".repeat(5000),
        () => {
          throw new Error("describe exploded");
        },
        () => "Send 4111 1111 1111 1111 with sk-or-v1-abcdefghijklmnopqrstuvwxyz012345", // gitleaks:allow (fake)
      ),
    },
    { requiredKeys: [] },
  )
  .map((h) => h as ToolSafetyHints);

/** A Luhn-valid card number for a real issuer prefix, 13–19 digits. */
export const cardNumber: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("4", "51", "55", "22", "27", "34", "37", "36", "35", "6011", "62"),
    fc.integer({ min: 13, max: 19 }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 19, maxLength: 19 }),
  )
  .map(([prefix, length, fill]) => {
    const body = (prefix + fill.join("")).slice(0, length - 1);
    return body + luhnCheckDigit(body);
  })
  .filter((digits) => !/^(\d)\1+$/.test(digits));

export function luhnCheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Groups digits the way people paste them: plain, 4-4-4-4 with spaces, dashes, NBSP or dots. */
export function formatCard(digits: string, style: number): string {
  const groups = digits.match(/.{1,4}/g) ?? [digits];
  const separators = ["", " ", "-", "\u00A0", ".", "  ", " - "];
  return groups.join(separators[style % separators.length]);
}

/** Secrets in well-known formats (synthetic). */
export const tokenSecret: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({
      unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
      minLength: 36,
      maxLength: 40,
    })
    .map((s) => `ghp_${s}`),
  fc
    .string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
      minLength: 32,
      maxLength: 48,
    })
    .map((s) => `sk-or-v1-${s}`),
  fc
    .string({
      unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
      minLength: 16,
      maxLength: 16,
    })
    .map((s) => `AKIA${s}`),
  fc
    .string({
      unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
      minLength: 24,
      maxLength: 30,
    })
    .map((s) => `sk_live_${s}`),
);

/** Passwords a person might type: short and memorable or long and random. */
export const password: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({ unit: "grapheme-ascii", minLength: 6, maxLength: 24 })
    .filter((s) => s.trim().length >= 6),
  fc.constantFrom("hunter22", "correct horse battery staple", "P@ssw0rd!", "Tr0ub4dor&3"),
);

/**
 * Where the Daily Do List editor deliberately differs from plain CodeMirror: upstream tests that
 * fail against it, and vectors its replay skips. Every entry names the editor behavior responsible;
 * anything else that fails is an integration bug.
 */

const JAVASCRIPT =
  "upstream runs it with the JavaScript language; the editor's language is markdown";

export const WEB_EXPECTED_FAILURES: Readonly<Record<string, string>> = {
  vim_j_with_folding: `${JAVASCRIPT} (it folds the C sample's braces, markdown can't)`,
  vim_k_with_folding: `${JAVASCRIPT} (it folds the C sample's braces, markdown can't)`,
  "vim_%_seek_skip": `${JAVASCRIPT} (\`%\` skips brackets inside JavaScript strings)`,
  "vim_%_skip_string": `${JAVASCRIPT} (\`%\` skips brackets inside JavaScript strings)`,
  "vim_%_skip_comment": `${JAVASCRIPT} (\`%\` skips brackets inside JavaScript comments)`,
  'vim_ci" for two strings': `${JAVASCRIPT} (quote objects use JavaScript string tokens)`,
  vim_gcc: `${JAVASCRIPT} (\`gc\` needs line-comment tokens; markdown has none)`,
  "vim_=": `${JAVASCRIPT} (\`=\` re-indents by JavaScript's indentation rules)`,
  vim_s_visual_block: `${JAVASCRIPT} (it expects a new line after \`{\` to be indented)`,
  "vim_._insert_o_indent": `${JAVASCRIPT} (it expects a new line after \`{\` to be indented)`,
  vim_dat_open_tag:
    "tag objects need an XML/HTML syntax tree; markdown's inline HTML has no tag nodes",
  vim_dat_inside_tag:
    "tag objects need an XML/HTML syntax tree; markdown's inline HTML has no tag nodes",
  vim_dat_close_tag:
    "tag objects need an XML/HTML syntax tree; markdown's inline HTML has no tag nodes",
  vim_dit_open_tag:
    "tag objects need an XML/HTML syntax tree; markdown's inline HTML has no tag nodes",
  vim_dit_inside_tag:
    "tag objects need an XML/HTML syntax tree; markdown's inline HTML has no tag nodes",
  vim_dit_close_tag:
    "tag objects need an XML/HTML syntax tree; markdown's inline HTML has no tag nodes",
};

const UNRENDERED_PAGE =
  "the page motion's target line isn't rendered yet, so CodeMirror resolves it from estimated line " +
  "heights, and the editor's line wrapping changes the estimate by a pixel at a line boundary";

/** Case names, or name prefixes ending in `*`. */
export const REPLAY_SKIPS: Readonly<Record<string, string>> = {
  "edit/r<CR>/words/bof/count-3":
    "vim's newlineAndIndent asks the language for the indentation: markdown keeps the leading " +
    "space of the paragraph the break lands before, the oracle (no language) doesn't",
  "viewport/<C-f>/screen-bottom": UNRENDERED_PAGE,
  "viewport/<PageDown>/screen-bottom": UNRENDERED_PAGE,
  "viewport/2<C-f>/top": UNRENDERED_PAGE,
  "viewport/2<C-f>/screen-middle": UNRENDERED_PAGE,
};

export function skipReason(name: string): string | undefined {
  const exact = REPLAY_SKIPS[name];
  if (exact !== undefined) return exact;
  for (const [pattern, reason] of Object.entries(REPLAY_SKIPS)) {
    if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return reason;
  }
  return undefined;
}

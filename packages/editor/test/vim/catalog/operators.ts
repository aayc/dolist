/** The operator × motion × count matrix, doubled (linewise) operators, and cancelled operators. */
import { type Catalog, label } from "./builder";
import {
  BLANK,
  BRACKETS,
  CODE,
  type Doc,
  INDENTED,
  PROSE,
  PUNCT,
  SINGLE,
  UNICODE,
  WORDS,
} from "./docs";

type Start = readonly [Doc, string];

interface MatrixMotion {
  /** Name in the case path. */
  id: string;
  /** Keys typed after the operator (and its count). */
  motion: string;
  /** Keys that prepare the state (a search, a mark) before the operator. */
  setup?: string;
  starts: readonly Start[];
  /** The motion takes a count (false for searches that prompt, marks, ...). */
  countable?: boolean;
}

const MOTIONS: readonly MatrixMotion[] = [
  {
    id: "h",
    motion: "h",
    starts: [
      [WORDS, "mid-word"],
      [WORDS, "bof"],
    ],
  },
  {
    id: "l",
    motion: "l",
    starts: [
      [WORDS, "mid-word"],
      [WORDS, "eol"],
    ],
  },
  {
    id: "j",
    motion: "j",
    starts: [
      [WORDS, "mid-word"],
      [WORDS, "last-line"],
    ],
  },
  {
    id: "k",
    motion: "k",
    starts: [
      [WORDS, "word-end"],
      [WORDS, "bof"],
    ],
  },
  {
    id: "w",
    motion: "w",
    starts: [
      [WORDS, "mid-word"],
      [WORDS, "eol"],
      [PUNCT, "dot"],
      [BLANK, "first"],
    ],
  },
  {
    id: "W",
    motion: "W",
    starts: [
      [PUNCT, "bof"],
      [PUNCT, "arrow"],
    ],
  },
  {
    id: "b",
    motion: "b",
    starts: [
      [WORDS, "mid-word"],
      [WORDS, "word-end"],
      [PUNCT, "comma"],
    ],
  },
  { id: "B", motion: "B", starts: [[PUNCT, "comma"]] },
  {
    id: "e",
    motion: "e",
    starts: [
      [WORDS, "mid-word"],
      [PUNCT, "dot"],
      [UNICODE, "accent"],
    ],
  },
  { id: "E", motion: "E", starts: [[PUNCT, "bof"]] },
  {
    id: "ge",
    motion: "ge",
    starts: [
      [WORDS, "space"],
      [WORDS, "last-line"],
    ],
  },
  { id: "gE", motion: "gE", starts: [[PUNCT, "colons"]] },
  {
    id: "0",
    motion: "0",
    countable: false,
    starts: [
      [WORDS, "mid-word"],
      [INDENTED, "four-spaces"],
    ],
  },
  {
    id: "^",
    motion: "^",
    starts: [
      [INDENTED, "four-spaces"],
      [INDENTED, "unindented"],
    ],
  },
  {
    id: "$",
    motion: "$",
    starts: [
      [WORDS, "mid-word"],
      [BLANK, "empty"],
    ],
  },
  { id: "|", motion: "|", starts: [[WORDS, "eol"]] },
  { id: "gg", motion: "gg", starts: [[WORDS, "last-line"]] },
  { id: "G", motion: "G", starts: [[WORDS, "mid-word"]] },
  { id: "+", motion: "+", starts: [[INDENTED, "space-indent"]] },
  { id: "-", motion: "-", starts: [[INDENTED, "four-spaces"]] },
  { id: "_", motion: "_", starts: [[INDENTED, "tab-start"]] },
  { id: "CR", motion: "<CR>", starts: [[WORDS, "mid-word"]] },
  { id: "Space", motion: "<Space>", starts: [[WORDS, "mid-word"]] },
  { id: "BS", motion: "<BS>", starts: [[WORDS, "mid-word"]] },
  {
    id: "f",
    motion: "fe",
    starts: [
      [WORDS, "bof"],
      [UNICODE, "accent"],
    ],
  },
  { id: "F", motion: "Fo", starts: [[WORDS, "eof"]] },
  { id: "t", motion: "te", starts: [[WORDS, "bof"]] },
  { id: "T", motion: "To", starts: [[WORDS, "eof"]] },
  { id: "semicolon", motion: ";", setup: "fe0", starts: [[WORDS, "bof"]] },
  { id: "comma", motion: ",", setup: "fe$", starts: [[WORDS, "bof"]] },
  {
    id: "%",
    motion: "%",
    countable: false,
    starts: [
      [BRACKETS, "on-open"],
      [BRACKETS, "in-round"],
    ],
  },
  {
    id: "(",
    motion: "(",
    starts: [
      [PROSE, "mid-sentence"],
      [PROSE, "second-para"],
    ],
  },
  {
    id: ")",
    motion: ")",
    starts: [
      [PROSE, "bof"],
      [PROSE, "double-space"],
    ],
  },
  { id: "{", motion: "{", starts: [[PROSE, "para-end"]] },
  {
    id: "}",
    motion: "}",
    starts: [
      [PROSE, "bof"],
      [PROSE, "second-para"],
    ],
  },
  { id: "[[", motion: "[[", starts: [[CODE, "in-braces"]] },
  { id: "]]", motion: "]]", starts: [[CODE, "bof"]] },
  { id: "[(", motion: "[(", starts: [[CODE, "in-parens"]] },
  { id: "]}", motion: "]}", starts: [[CODE, "in-brackets"]] },
  { id: "H", motion: "H", starts: [[WORDS, "last-line"]] },
  { id: "M", motion: "M", countable: false, starts: [[PROSE, "bof"]] },
  { id: "L", motion: "L", starts: [[WORDS, "bof"]] },
  { id: "n", motion: "n", setup: "/e<CR>0", starts: [[WORDS, "bof"]] },
  { id: "N", motion: "N", setup: "/e<CR>$", starts: [[WORDS, "bof"]] },
  { id: "star", motion: "*", starts: [[WORDS, "bof"]] },
  { id: "hash", motion: "#", starts: [[WORDS, "last-line"]] },
  {
    id: "search",
    motion: "/five<CR>",
    countable: false,
    starts: [
      [WORDS, "bof"],
      [WORDS, "eof"],
    ],
  },
  { id: "search-back", motion: "?two<CR>", countable: false, starts: [[WORDS, "eof"]] },
  { id: "mark-exact", motion: "`a", setup: "mawwj", countable: false, starts: [[WORDS, "bof"]] },
  { id: "mark-line", motion: "'a", setup: "majw", countable: false, starts: [[WORDS, "mid-word"]] },
  { id: "gn", motion: "gn", setup: "/four<CR>gg", countable: false, starts: [[WORDS, "bof"]] },
];

interface Operator {
  id: string;
  keys: string;
  /** Typed after the operator to leave insert mode. */
  insert?: string;
  vim?: Record<string, number>;
}

const OPERATORS: readonly Operator[] = [
  { id: "d", keys: "d" },
  { id: "c", keys: "c", insert: "X<Esc>" },
  { id: "y", keys: "y" },
  { id: ">", keys: ">" },
  { id: "<", keys: "<" },
  { id: "g~", keys: "g~" },
  { id: "gu", keys: "gu" },
  { id: "gU", keys: "gU" },
  { id: "g?", keys: "g?" },
  { id: "gq", keys: "gq", vim: { textwidth: 12 } },
  { id: "gw", keys: "gw", vim: { textwidth: 12 } },
];

const INDENT_DOC_LINES = ["\tone two three", "four five six", "  seven eight"];

function startDoc(op: Operator, doc: Doc): string {
  // Dedent needs indentation to remove.
  return op.id === "<" && doc === WORDS ? INDENT_DOC_LINES.join("\n") : doc.text;
}

function addStep(steps: string[], op: Operator, keys: string): void {
  steps.push(keys);
  if (op.insert) steps.push(op.insert);
}

export function addOperators(catalog: Catalog): void {
  for (const op of OPERATORS) {
    for (const motion of MOTIONS) {
      for (const [doc, posName] of motion.starts) {
        const at = doc.at[posName];
        if (!at) throw new Error(`${doc.id} has no position ${posName}`);
        const base = `operator/${label(op.id)}/${label(motion.id)}/${doc.id}/${posName}`;
        const variants: Array<[string, string]> = [["", `${op.keys}${motion.motion}`]];
        if (motion.countable !== false) {
          variants.push(["count-before-operator", `2${op.keys}${motion.motion}`]);
          variants.push(["count-before-motion", `${op.keys}2${motion.motion}`]);
        }
        for (const [variant, keys] of variants) {
          const steps: string[] = [];
          if (motion.setup) steps.push(motion.setup);
          addStep(steps, op, keys);
          steps.push("u");
          catalog.add({
            name: variant ? `${base}/${variant}` : base,
            doc: startDoc(op, doc),
            at,
            ...(op.vim ? { vim: op.vim } : {}),
            steps,
          });
        }
      }
    }
  }

  // Doubled operators act on whole lines; counts and the `{op}{count}{op}` form multiply.
  const doubled: Record<string, readonly string[]> = {
    d: ["dd"],
    c: ["cc"],
    y: ["yy"],
    ">": [">>"],
    "<": ["<<"],
    "g~": ["g~~", "g~g~"],
    gu: ["guu", "gugu"],
    gU: ["gUU", "gUgU"],
    "g?": ["g??", "g?g?"],
    gq: ["gqq", "gqgq"],
    gw: ["gww"],
  };
  const lineDocs: ReadonlyArray<readonly [Doc, string]> = [
    [WORDS, "mid-word"],
    [WORDS, "last-line"],
    [INDENTED, "four-spaces"],
    [BLANK, "empty"],
    [SINGLE, "mid"],
    [UNICODE, "cjk"],
  ];
  for (const op of OPERATORS) {
    for (const keys of doubled[op.id] ?? []) {
      for (const [doc, posName] of lineDocs) {
        const at = doc.at[posName]!;
        for (const [variant, typed] of [
          ["", keys],
          ["count-3", `3${keys}`],
          ["count-inside", `${op.keys}2${keys.slice(op.keys.length)}`],
          ["count-past-end", `9${keys}`],
        ] as const) {
          const steps: string[] = [];
          addStep(steps, op, typed);
          steps.push("u", "<C-r>");
          catalog.add({
            name: `operator/${label(op.id)}/${label(keys)}/${doc.id}/${posName}${variant ? `/${variant}` : ""}`,
            doc: startDoc(op, doc),
            at,
            ...(op.vim ? { vim: op.vim } : {}),
            steps,
          });
        }
      }
    }
  }

  // Pending operators that are cancelled or can't combine.
  for (const [id, keys] of Object.entries({
    escape: "d<Esc>",
    "unknown-motion": "dZ",
    "two-operators": "dy",
    "count-then-escape": "3d<Esc>",
    "operator-then-visual": "dv",
    "register-then-escape": '"a<Esc>',
  })) {
    catalog.add({ name: `operator/cancel/${id}`, doc: WORDS.text, at: [0, 4], steps: [keys, "x"] });
  }
}

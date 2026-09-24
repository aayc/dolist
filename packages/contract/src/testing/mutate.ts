import fc from "fast-check";
import type { z } from "zod";

type Path = Array<string | number>;

/** Values that break most fields: wrong types, out-of-range numbers, empty and oversized strings. */
const WRONG_VALUES: unknown[] = [
  null,
  0,
  -1,
  1.5,
  2 ** 53,
  "",
  "not-a-valid-value",
  "x".repeat(5_000),
  true,
  [],
  {},
  [null],
  { nested: { deep: true } },
];

const EXTRA_KEYS = ["sneaky", "__extra", "Type", "", "constructor"];

/** Paths of every node in a JSON value, root first. */
function nodePaths(value: unknown, path: Path = [], out: Path[] = []): Path[] {
  out.push(path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      nodePaths(item, [...path, i], out);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) nodePaths(item, [...path, key], out);
  }
  return out;
}

function parentOf(root: unknown, path: Path): Record<string | number, unknown> | null {
  let node = root;
  for (const key of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[key];
  }
  return node !== null && typeof node === "object"
    ? (node as Record<string | number, unknown>)
    : null;
}

type Op = "drop" | "replace" | "addKey";

function apply(value: unknown, path: Path, op: Op, wrong: unknown, key: string): unknown {
  const root = structuredClone(value);
  if (path.length === 0) {
    if (op === "addKey" && root !== null && typeof root === "object" && !Array.isArray(root)) {
      Object.defineProperty(root, key, {
        value: wrong,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return root;
    }
    return wrong;
  }
  const parent = parentOf(root, path);
  const last = path[path.length - 1]!;
  if (!parent) return root;
  const target = parent[last];
  if (op === "drop") {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  } else if (
    op === "addKey" &&
    target !== null &&
    typeof target === "object" &&
    !Array.isArray(target)
  ) {
    Object.defineProperty(target, key, {
      value: wrong,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    parent[last] = wrong;
  }
  return root;
}

/** Random single-point mutations of a JSON value: drop a key, replace a value, add a key. */
export function mutate(value: unknown): fc.Arbitrary<unknown> {
  const paths = nodePaths(value);
  return fc
    .record({
      path: fc.constantFrom(...paths),
      op: fc.constantFrom<Op>("drop", "replace", "addKey"),
      wrong: fc.constantFrom(...WRONG_VALUES),
      key: fc.constantFrom(...EXTRA_KEYS),
    })
    .map(({ path, op, wrong, key }) => apply(value, path, op, wrong, key));
}

/** Values derived from valid ones by one mutation that `schema` rejects. */
export function invalidFor(schema: z.ZodType, valid: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> {
  return valid.chain(mutate).filter((candidate) => !schema.safeParse(candidate).success);
}

/** The valid value with one unknown key added at the top level (strict schemas reject it). */
export function withExtraKey<T extends object>(
  value: T,
  key = "sneaky",
): T & Record<string, unknown> {
  return { ...value, [key]: true };
}

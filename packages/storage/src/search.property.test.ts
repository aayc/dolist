import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHiddenPath, isMarkdownPath, type SearchHit, stem } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "./file-types";
import { LocalFsStorageProvider } from "./local-fs";
import { MemoryStorageProvider } from "./memory";
import { searchVault } from "./search";

const WORDS = [
  "Call",
  "mom",
  "dentist",
  "LISBON",
  "flights",
  "garden",
  "İstanbul",
  "ΟΔΟΣ",
  "🎉",
  "a/b",
  "x",
];
const lineArb = fc.oneof(
  fc.array(fc.constantFrom(...WORDS), { maxLength: 6 }).map((w) => w.join(" ")),
  fc.constantFrom("", "   ", `${"long ".repeat(40)}dentist${" tail".repeat(40)}`),
);
const contentArb = fc
  .tuple(fc.array(lineArb, { maxLength: 6 }), fc.constantFrom("\n", "\r\n"))
  .map(([lines, eol]) => lines.join(eol));
const pathArb = fc.constantFrom(
  "Garden.md",
  "Daily/2026-09-23.md",
  "Daily/call mom.md",
  "Trips/Lisbon flights.md",
  ".daily-do-list/notes.md",
  "Projects/.draft dentist.md",
  "data.json",
  "notes.txt",
);
const vaultArb = fc.dictionary(pathArb, contentArb, { maxKeys: 8 });
const queryArb = fc.oneof(
  fc
    .array(
      fc.constantFrom(
        "call",
        "MOM",
        "dentist",
        "lisbon",
        "flights",
        "garden",
        "i̇stanbul",
        "οδος",
        "🎉",
        "daily/",
        "2026",
        "x",
      ),
      {
        minLength: 1,
        maxLength: 3,
      },
    )
    .map((terms) => terms.join(" ")),
  fc.constantFrom("", "   ", "zzz-no-match"),
);

/** Brute-force reference: the full, ordered hit list without a limit. */
async function oracle(
  provider: MemoryStorageProvider,
  query: string,
  { includeHidden = false, maxFileBytes = 1_000_000 } = {},
): Promise<Array<Pick<SearchHit, "path" | "kind" | "line">>> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const terms = [...new Set(needle.split(/\s+/))];
  const notes = (await provider.list({ includeHidden }))
    .filter((f) => isMarkdownPath(f.path) && (includeHidden || !isHiddenPath(f.path)))
    .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1));
  const hits: Array<Pick<SearchHit, "path" | "kind" | "line">> = [];
  for (const note of notes) {
    const name = (needle.includes("/") ? note.path.slice(0, -3) : stem(note.path)).toLowerCase();
    if (terms.every((t) => name.includes(t))) hits.push({ path: note.path, kind: "name", line: 0 });
  }
  for (const note of notes) {
    const text = (await provider.read(note.path))!.content;
    if (utf8ByteLength(text) > maxFileBytes) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      const lower = line.toLowerCase();
      if (terms.every((t) => lower.includes(t)))
        hits.push({ path: note.path, kind: "content", line: i });
    });
  }
  return hits;
}

function checkPreviews(
  hits: readonly SearchHit[],
  files: Record<string, string>,
  query: string,
): void {
  const first = query.trim().toLowerCase().split(/\s+/)[0]!;
  for (const hit of hits) {
    if (hit.kind === "name") {
      expect(hit.preview).toBe(hit.path);
      continue;
    }
    const line = files[hit.path]!.split(/\r?\n/)[hit.line]!;
    if (line.length <= 160) {
      expect(hit.preview).toBe(line.trim());
      continue;
    }
    expect(hit.preview.length).toBeLessThanOrEqual(162);
    expect(line).toContain(hit.preview.replace(/^…|…$/g, ""));
    expect(hit.preview.toLowerCase()).toContain(first);
  }
}

function vault(files: Record<string, string>): MemoryStorageProvider {
  let t = 1_000;
  return new MemoryStorageProvider({ initialFiles: files, now: () => t++ });
}

describe("searchVault", () => {
  test.prop([vaultArb, queryArb, fc.boolean(), fc.constantFrom(20, 200, 1_000_000)])(
    "returns exactly the brute-force hits, in order",
    async (files, query, includeHidden, maxFileBytes) => {
      const s = vault(files);
      const hits = await searchVault(s, query, { includeHidden, maxFileBytes, limit: 10_000 });
      expect(hits.map(({ path, kind, line }) => ({ path, kind, line }))).toEqual(
        await oracle(s, query, { includeHidden, maxFileBytes }),
      );
      checkPreviews(hits, files, query);
    },
  );

  test.prop([vaultArb, queryArb, fc.integer({ min: -1, max: 12 })])(
    "a limit keeps a prefix of the unlimited results",
    async (files, query, limit) => {
      const s = vault(files);
      const all = await searchVault(s, query, { limit: 10_000 });
      const limited = await searchVault(s, query, { limit });
      expect(limited).toEqual(all.slice(0, Math.max(0, limit)));
    },
  );

  type Step =
    | { kind: "write"; path: string; content: string }
    | { kind: "delete"; path: string }
    | { kind: "search"; query: string };
  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ kind: fc.constant("write" as const), path: pathArb, content: contentArb }),
    fc.record({ kind: fc.constant("delete" as const), path: pathArb }),
    fc.record({ kind: fc.constant("search" as const), query: queryArb }),
  );

  test.prop([vaultArb, fc.array(stepArb, { maxLength: 15 })])(
    "stays correct across writes and deletes (cache invalidation)",
    async (files, steps) => {
      const s = vault(files);
      for (const step of steps) {
        if (step.kind === "write") await s.write(step.path, step.content);
        else if (step.kind === "delete") await s.delete(step.path).catch(() => {});
        else {
          const hits = await searchVault(s, step.query, { limit: 10_000 });
          expect(hits.map(({ path, kind, line }) => ({ path, kind, line }))).toEqual(
            await oracle(s, step.query),
          );
        }
      }
    },
  );

  it("finds edits made behind a local vault's back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ddl-search-"));
    const s = new LocalFsStorageProvider({ root: dir });
    try {
      await s.write("a.md", "alpha");
      expect(await searchVault(s, "alpha")).toHaveLength(1);
      await writeFile(join(dir, "a.md"), "beta, longer now");
      await writeFile(join(dir, "b.md"), "alpha again");
      expect((await searchVault(s, "alpha")).map((h) => h.path)).toEqual(["b.md"]);
      expect((await searchVault(s, "beta")).map((h) => h.path)).toEqual(["a.md"]);
    } finally {
      await s.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches case-insensitively across scripts, including length-changing lowercase", async () => {
    const s = vault({ "a.md": "İstanbul ferry\nΟΔΟΣ ΣΙΣΥΦΟΥ\n🎉 party" });
    expect((await searchVault(s, "i̇stanbul")).map((h) => h.line)).toEqual([0]);
    expect((await searchVault(s, "οδος")).map((h) => h.line)).toEqual([1]);
    expect((await searchVault(s, "🎉")).map((h) => h.line)).toEqual([2]);
  });
});

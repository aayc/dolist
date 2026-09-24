import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES, extname } from "@ddl/core";
import { LocalFsStorageProvider, MemoryStorageProvider, type StorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, tempDir } from "../test-helpers";
import {
  moveFolder,
  moveFolderToTrash,
  moveNoteToTrash,
  TRASH_DIR,
  trashCandidate,
} from "../vault-ops";
import { ioRuns, ioTimeout, snapshotTree } from "./harness";

const NOW = new Date(2026, 8, 23, 21, 59, 0);
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

const dirs: Array<{ path: string; cleanup: () => void }> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) dir.cleanup();
});

function localVault(files: Record<string, string> = {}): {
  storage: LocalFsStorageProvider;
  root: string;
} {
  const dir = tempDir("ddl-trash-");
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir.path, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir.path, ...path.split("/")), content);
  }
  return { storage: new LocalFsStorageProvider({ root: dir.path }), root: dir.path };
}

/** A file system that treats `A` and `a` as the same name (macOS and Windows defaults). */
function caseInsensitiveFs(): boolean {
  const dir = tempDir("ddl-case-");
  dirs.push(dir);
  writeFileSync(join(dir.path, "probe"), "");
  return existsSync(join(dir.path, "PROBE"));
}

/**
 * Every note's content, trash included. Providers never list `.trash`, so this walks the disk, or
 * the memory provider's own map.
 */
async function contents(storage: StorageProvider): Promise<string[]> {
  if (storage instanceof LocalFsStorageProvider) {
    return [...snapshotTree(storage.root).keys()]
      .filter(
        (path) => !path.startsWith(".daily-do-list") && statSync(join(storage.root, path)).isFile(),
      )
      .map((path) => readFileSync(join(storage.root, path), "utf8"))
      .sort();
  }
  const files = (storage as unknown as { files: Map<string, { content: string }> }).files;
  return [...files]
    .filter(([path]) => !path.startsWith(".daily-do-list"))
    .map(([, file]) => file.content)
    .sort();
}

const segment = fc
  .stringMatching(/^[A-Za-z0-9 _()日😀é-]{1,40}$/u)
  .filter((s) => s.trim() === s && !s.startsWith("."));
const notePath = fc
  .tuple(fc.array(segment, { maxLength: 3 }), segment, fc.constantFrom(".md", ".txt", ".canvas"))
  .map(([dirs, name, ext]) => [...dirs, `${name}${ext}`].join("/"));

describe("trash candidates", () => {
  test.prop([
    fc.oneof(notePath, fc.stringMatching(/^[a-z]{200,260}\.md$/)),
    fc.boolean(),
    fc.date({ noInvalidDate: true }),
  ])(
    "are distinct, stay under .trash, keep the extension and fit one file name",
    (path, isFolder, now) => {
      const candidates = Array.from({ length: 30 }, (_, attempt) =>
        trashCandidate(path, isFolder, now, attempt),
      );
      expect(new Set(candidates).size).toBe(candidates.length);
      expect(candidates[0]).toBe(`${TRASH_DIR}/${path}`);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      for (const candidate of candidates.slice(1)) {
        expect(candidate.startsWith(`${TRASH_DIR}/${dir}`)).toBe(true);
        expect(utf8(basename(candidate))).toBeLessThanOrEqual(255);
        if (!isFolder) expect(extname(candidate)).toBe(extname(path));
        expect(candidate).not.toContain("\uFFFD");
      }
    },
  );
});

describe("repeated deletes of the same name", () => {
  const providers = {
    memory: () => new MemoryStorageProvider() as StorageProvider,
    local: () => localVault().storage as StorageProvider,
  };

  for (const [kind, create] of Object.entries(providers)) {
    const share = kind === "local" ? 0.1 : 0.5;
    test.prop(
      [
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.integer({ min: 0, max: 2_000 }), { maxLength: 12 }),
      ],
      { numRuns: ioRuns(share) },
    )(
      `never collide, whatever the clock does (${kind})`,
      async (count, offsets) => {
        const storage = create();
        for (let i = 0; i < count; i++) {
          await storage.write("Inbox/Idea.md", `copy ${i}`);
          const at = new Date(NOW.getTime() + (offsets[i] ?? 0));
          const moved = await moveNoteToTrash(storage, "Inbox/Idea.md", at);
          expect(moved.to.startsWith(".trash/Inbox/Idea")).toBe(true);
        }
        expect(await contents(storage)).toEqual(
          Array.from({ length: count }, (_, i) => `copy ${i}`).sort(),
        );
        await storage.dispose();
      },
      ioTimeout(share),
    );
  }

  it("never fails with 409 through the API, even within the same second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { storage } = localVault();
    const { request } = await createTestApp({ storage });
    const trashedTo = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await request(API_ROUTES.note("a.md"), { method: "PUT", json: { content: `v${i}` } });
      const res = await request(API_ROUTES.note("a.md"), { method: "DELETE" });
      expect(res.status, `delete #${i + 1}`).toBe(200);
      trashedTo.add(((await res.json()) as { trashedTo: string }).trashedTo);
    }
    expect([...trashedTo]).toEqual([
      ".trash/a.md",
      ".trash/a (2026-09-23 215900).md",
      ".trash/a (2026-09-23 215900 2).md",
      ".trash/a (2026-09-23 215900 3).md",
      ".trash/a (2026-09-23 215900 4).md",
    ]);
    await storage.dispose();
  });

  it("keeps long names under the file-name limit when a suffix is needed", async () => {
    const { storage, root } = localVault();
    const name = `${"n".repeat(250)}.md`;
    for (let i = 0; i < 3; i++) {
      await storage.write(name, `v${i}`);
      const moved = await moveNoteToTrash(storage, name, NOW);
      expect(utf8(basename(moved.to))).toBeLessThanOrEqual(255);
      expect(readFileSync(join(root, ...moved.to.split("/")), "utf8")).toBe(`v${i}`);
    }
    await storage.dispose();
  });

  it.runIf(process.platform === "darwin")(
    "fits multi-byte names that only APFS allows",
    async () => {
      const { storage } = localVault();
      const name = `${"日".repeat(200)}.md`;
      await storage.write(name, "v0");
      expect(basename((await moveNoteToTrash(storage, name, NOW)).to)).toBe(name);
      await storage.write(name, "v1");
      const suffixed = basename((await moveNoteToTrash(storage, name, NOW)).to);
      expect(utf8(suffixed)).toBeLessThanOrEqual(255);
      expect(suffixed.endsWith(" (2026-09-23 215900).md")).toBe(true);
      expect(await contents(storage)).toEqual(["v0", "v1"]);
      await storage.dispose();
    },
  );
});

describe("folder deletes", () => {
  it("trash the same folder name twice on disk, where .trash is never listed", async () => {
    const { storage } = localVault();
    const { request } = await createTestApp({ storage });
    for (let i = 0; i < 3; i++) {
      await storage.write("Projects/Kyoto/plan.md", `plan ${i}`);
      const res = await request(
        `${API_ROUTES.folders}?path=${encodeURIComponent("Projects/Kyoto")}`,
        {
          method: "DELETE",
        },
      );
      expect(res.status, `delete #${i + 1}`).toBe(200);
    }
    expect(await contents(storage)).toEqual(["plan 0", "plan 1", "plan 2"]);
    await storage.dispose();
  });

  for (const kind of ["memory", "local"] as const) {
    it(`move hidden files inside the folder along with it (${kind})`, async () => {
      const files = {
        "Projects/visible.md": "visible",
        "Projects/.hidden.md": "hidden",
        "Projects/sub/.config.json": "config",
        "Projects/sub/deep/n.md": "deep",
      };
      const storage =
        kind === "memory"
          ? new MemoryStorageProvider({ initialFiles: files })
          : localVault(files).storage;
      const moved = await moveFolderToTrash(storage, "Projects", NOW);
      expect(moved.map((m) => m.to).sort()).toEqual([
        ".trash/Projects/.hidden.md",
        ".trash/Projects/sub/.config.json",
        ".trash/Projects/sub/deep/n.md",
        ".trash/Projects/visible.md",
      ]);
      expect(await storage.list({ prefix: "Projects", includeHidden: true })).toEqual([]);
      expect(await contents(storage)).toEqual(["config", "deep", "hidden", "visible"]);
      await storage.dispose();
    });
  }

  // BUG (packages/storage local-fs + vault-ops, not fixable here): LocalFsStorageProvider never
  // lists `.git`, `.DS_Store`, `node_modules` or editor temp files, so moveFolder does not move them;
  // it then calls `deleteFolder`, which removes the source directory recursively, destroying them
  // permanently. Deleting or renaming a folder that contains a git repository loses the repository,
  // breaking the "deletes are soft" invariant. A folder-level move in the storage provider
  // (fs.rename of the directory) would carry everything along.
  it.fails("never destroy ignored content (.git, .DS_Store) inside a deleted or renamed folder", async () => {
    const { storage, root } = localVault({
      "code/readme.md": "# code",
      "code/.git/HEAD": "ref: refs/heads/main\n",
      "code/.DS_Store": "x",
      "code2/readme.md": "# code2",
      "code2/.git/HEAD": "ref: refs/heads/main\n",
    });
    await moveFolderToTrash(storage, "code", NOW);
    await moveFolder(storage, "code2", "moved");
    const survivors = [".trash/code/.git/HEAD", ".trash/code/.DS_Store", "moved/.git/HEAD"];
    for (const path of survivors)
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(true);
  });
});

describe("folder renames", () => {
  it("refuse to move a folder into itself, including through a case variant, losing nothing", async () => {
    const { storage } = localVault({
      "Projects/a.md": "precious",
      "Projects/sub/b.md": "also precious",
    });
    const { request } = await createTestApp({ storage });
    for (const to of ["Projects/Nested", "projects/Nested", "PROJECTS/sub/deeper", "Projects"]) {
      const res = await request(API_ROUTES.rename, {
        method: "POST",
        json: { from: "Projects", to },
      });
      expect([400, 409], to).toContain(res.status);
    }
    expect(await contents(storage)).toEqual(["also precious", "precious"]);
    await storage.dispose();
  });

  it("never lose an empty folder to a case-only rename", async () => {
    const { storage, root } = localVault();
    mkdirSync(join(root, "empty"));
    const { request } = await createTestApp({ storage });
    const res = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "empty", to: "Empty" },
    });
    if (caseInsensitiveFs()) {
      expect(res.status).toBe(409);
      expect(existsSync(join(root, "empty"))).toBe(true);
    } else {
      expect(res.status).toBe(200);
      expect(existsSync(join(root, "Empty"))).toBe(true);
    }
    await storage.dispose();
  });

  it("refuse targets that are, or sit under, an existing file", async () => {
    const { storage } = localVault({ "a/x.md": "x", "b.md": "b" });
    const { request } = await createTestApp({ storage });
    for (const to of ["b.md", "b.md/sub"]) {
      const res = await request(API_ROUTES.rename, { method: "POST", json: { from: "a", to } });
      expect(res.status, to).toBe(409);
    }
    expect(await contents(storage)).toEqual(["b", "x"]);
    await storage.dispose();
  });
});

describe("soft deletes never lose data", () => {
  type Op =
    | { op: "put"; path: string }
    | { op: "deleteNote"; path: string }
    | { op: "deleteFolder"; path: string }
    | { op: "renameFolder"; from: string; to: string }
    | { op: "tick"; seconds: number };

  const notes = fc.constantFrom("a.md", "F/b.md", "F/G/c.md", "H/d.md", "F/.hidden.md");
  const folders = fc.constantFrom("F", "F/G", "H");
  const op: fc.Arbitrary<Op> = fc.oneof(
    { weight: 3, arbitrary: fc.record({ op: fc.constant("put" as const), path: notes }) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant("deleteNote" as const), path: notes }) },
    {
      weight: 2,
      arbitrary: fc.record({ op: fc.constant("deleteFolder" as const), path: folders }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        op: fc.constant("renameFolder" as const),
        from: folders,
        to: fc.constantFrom("H", "F/G2", "f/x", "F/G/in", "K"),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ op: fc.constant("tick" as const), seconds: fc.constantFrom(0, 1) }),
    },
  );

  test.prop([fc.array(op, { minLength: 1, maxLength: 30 })], { numRuns: ioRuns(0.5) })(
    "every note ever written survives in the vault or its trash, and deletes of existing items succeed",
    async (ops) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const storage = new MemoryStorageProvider();
      const { request } = await createTestApp({ storage });
      const expected: string[] = [];
      let counter = 0;
      for (const step of ops) {
        let res: Response | undefined;
        if (step.op === "tick") {
          vi.setSystemTime(Date.now() + step.seconds * 1_000);
          continue;
        }
        if (step.op === "put") {
          const existing = await storage.read(step.path);
          const content = `c${counter++}`;
          // Writes to hidden paths are refused; overwrites replace content by design.
          res = await request(API_ROUTES.note(step.path), { method: "PUT", json: { content } });
          if (res.ok) {
            if (existing) expected.splice(expected.indexOf(existing.content), 1);
            expected.push(content);
          }
        } else if (step.op === "deleteNote") {
          const exists = (await storage.stat(step.path)) !== null;
          res = await request(API_ROUTES.note(step.path), { method: "DELETE" });
          if (exists && !step.path.includes("/."))
            expect(res.status, JSON.stringify(step)).toBe(200);
        } else if (step.op === "deleteFolder") {
          const exists = (await storage.listFolders()).includes(step.path);
          res = await request(`${API_ROUTES.folders}?path=${encodeURIComponent(step.path)}`, {
            method: "DELETE",
          });
          if (exists) expect(res.status, JSON.stringify(step)).toBe(200);
        } else {
          res = await request(API_ROUTES.rename, {
            method: "POST",
            json: { from: step.from, to: step.to },
          });
        }
        expect(res.status, JSON.stringify(step)).toBeLessThan(500);
        expect(await contents(storage), JSON.stringify(step)).toEqual([...expected].sort());
      }
    },
    ioTimeout(0.5),
  );
});

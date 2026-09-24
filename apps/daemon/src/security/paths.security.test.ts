import { existsSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES, type ArtifactMeta, isHiddenPath } from "@ddl/core";
import { LocalFsStorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, FakeAgentRuntime, type TestApp } from "../test-helpers";
import { notePathFromUrl, resolveVaultPath } from "../vault-paths";
import {
  type CanaryVault,
  changedPaths,
  createCanaryVault,
  forbiddenChanges,
  ioRuns,
  ioTimeout,
} from "./harness";

/** URL-encoded note paths that decode to an escape, a hidden path, a control character or junk. */
const HOSTILE_NOTE_PATHS = [
  "..%2Foutside.md",
  "..%2F..%2Foutside.md",
  "%2e%2e%2Foutside.md",
  "%2E%2E%2foutside.md",
  ".%2E%2Foutside.md",
  "..%5Coutside.md",
  "..%5C..%5Csecret.env",
  "Notes%2F..%2F..%2Foutside.md",
  "Notes/visible.md%2F..%2F..%2F..%2Foutside.md",
  "..%2Fvault-evil%2Fescaped.md",
  "C:%5C..%5C..%5Coutside.md",
  "%c0%ae%c0%ae%2Foutside.md",
  "%e0%80%ae%e0%80%ae%2Foutside.md",
  "%C0%AF..%C0%AFoutside.md",
  "%ff.md",
  "%E0%A4%A.md",
  "%.md",
  ".daily-do-list%2Fstate%2Fcanary.json",
  "%2Edaily-do-list/state/canary.json",
  ".obsidian/app.json",
  "%2eobsidian%2fapp.json",
  ".trash/old.md",
  "%2Etrash%2Fold.md",
  "Notes/%2E%2E%2F.trash%2Fold.md",
  ".hidden.md",
  "%2ehidden.md",
  "Notes%2F..%2F.hidden.md",
  ".git%2Fconfig.md",
  "a%00.md",
  "Notes/visible.md%00.png",
  "a%0a.md",
  "a%0D.md",
  "a%09.md",
  "a%1b.md",
  "a%7f.md",
  "Notes/visible.md.",
  "Notes/visible.md%20",
  "Notes/visible",
  "Notes/visible.png",
  "Notes/visible.MD.exe",
  "%2F",
  "%5C",
  `${"a".repeat(256)}.md`,
];

/** Odd but legitimate names: they may be created, but only as visible files inside the vault. */
const ODD_NOTE_PATHS = [
  "%2Fetc%2Fpasswd.md",
  "%252e%252e%252foutside.md",
  "%EF%BC%8E%EF%BC%8E/outside.md",
  "%EF%BC%8E%EF%BC%8E%EF%BC%8Foutside.md",
  "%E2%80%A4%E2%80%A4/outside.md",
  "Cafe%CC%81.md",
  "CON.md",
  "NUL.md",
  "COM1.md",
  "folder./a.md",
  "folder%20/a.md",
  "...md",
  ".../x.md",
  "%E2%80%AEdm.exe.md",
  "a%3Fb%23c.md",
  `${"a".repeat(252)}.md`,
];

/** Hostile values for JSON bodies and query parameters (not URL-encoded). */
const HOSTILE_PATHS = [
  "../outside.md",
  "Notes/../../outside.md",
  "..\\outside.md",
  "Notes\\..\\..\\secret.env",
  "../vault-evil/escaped.md",
  ".trash/old.md",
  ".obsidian/app.json",
  ".daily-do-list/state/canary.json",
  ".hidden.md",
  "Notes/.hidden.md",
  "Notes/link-out.md",
  "Notes/dir-out/outside.md",
  "a\u0000.md",
  "a\n.md",
  "",
  "/",
  ".",
  "..",
  "Notes/..",
];

let canary: CanaryVault;
let app: TestApp<LocalFsStorageProvider>;
let runtime: FakeAgentRuntime;

// One vault for the file: @fast-check/vitest re-runs beforeEach/afterEach hooks for every generated
// case, so per-test setup would rebuild it for each run. Every test diffs its own snapshots.
beforeAll(async () => {
  canary = createCanaryVault();
  symlinkSync(join(canary.root, "outside.md"), join(canary.vault, "Notes", "link-out.md"));
  symlinkSync(canary.root, join(canary.vault, "Notes", "dir-out"));
  runtime = new FakeAgentRuntime();
  app = await createTestApp({
    storage: new LocalFsStorageProvider({ root: canary.vault }),
    runtime,
  });
});

afterAll(async () => {
  await app.storage.dispose();
  canary.cleanup();
});

/** Paths (relative to the canary root) that changed while `fn` ran. */
async function diskChanges(fn: () => Promise<void>): Promise<string[]> {
  const before = canary.snapshot();
  await fn();
  return changedPaths(before, canary.snapshot());
}

async function send(method: string, path: string, json?: unknown): Promise<Response> {
  return app.request(path, { method, ...(json === undefined ? {} : { json }) });
}

const bodyFor = (method: string, content: string) => (method === "PUT" ? { content } : undefined);

/**
 * True when a file sits where the note's folder should be, or a folder where the note should be.
 * BUG (reported in storage-errors.robustness.test.ts): such writes answer 500 instead of 409.
 */
function somethingInTheWay(encoded: string): boolean {
  let path: string;
  try {
    path = notePathFromUrl(`http://127.0.0.1/api/notes/${encoded}`);
  } catch {
    return false;
  }
  const segments = path.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const stats = statSync(join(canary.vault, ...segments.slice(0, i)), { throwIfNoEntry: false });
    if (!stats) return false;
    if (i < segments.length ? !stats.isDirectory() : stats.isDirectory()) return true;
  }
  return false;
}

describe("hostile note paths", () => {
  it(`rejects ${HOSTILE_NOTE_PATHS.length} hostile encodings for every method without touching the disk`, async () => {
    for (const encoded of HOSTILE_NOTE_PATHS) {
      const changes = await diskChanges(async () => {
        for (const method of ["GET", "PUT", "DELETE"]) {
          const res = await send(method, `/api/notes/${encoded}`, bodyFor(method, "pwned"));
          expect([400, 404], `${method} ${encoded}`).toContain(res.status);
          expect(await res.text(), `${method} ${encoded}`).not.toContain("canary");
        }
      });
      expect(changes, encoded).toEqual([]);
    }
  });

  it("refuses to follow symlinks that leave the vault", async () => {
    const changes = await diskChanges(async () => {
      for (const path of [
        "Notes/link-out.md",
        "Notes/dir-out/outside.md",
        "Notes/dir-out/vault-evil/escaped.md",
      ]) {
        for (const method of ["GET", "PUT", "DELETE"]) {
          const res = await send(method, API_ROUTES.note(path), bodyFor(method, "pwned"));
          expect([400, 404], `${method} ${path}`).toContain(res.status);
          expect(await res.text()).not.toContain("canary");
        }
      }
    });
    expect(changes).toEqual([]);
  });

  it("creates odd but legitimate names only as visible files inside the vault", async () => {
    const changes = await diskChanges(async () => {
      for (const encoded of ODD_NOTE_PATHS) {
        const res = await send("PUT", `/api/notes/${encoded}`, { content: "odd" });
        expect([200, 201, 400], encoded).toContain(res.status);
        if (res.status >= 400) continue;
        const { path } = (await res.json()) as { path: string };
        expect(isHiddenPath(path), path).toBe(false);
        expect(path.split("/")).not.toContain("..");
        expect(existsSync(join(canary.vault, ...path.split("/"))), path).toBe(true);
        expect((await send("GET", `/api/notes/${encoded}`)).status).toBe(200);
      }
    });
    expect(changes.length).toBeGreaterThan(0);
    expect(forbiddenChanges(changes)).toEqual([]);
  });
});

/** Pieces of hostile and odd path segments, recombined and re-encoded by the fuzzer. */
const piece = fc.constantFrom(
  "..",
  ".",
  "...",
  "",
  "Notes",
  "visible.md",
  "outside.md",
  "secret.env",
  "vault-evil",
  "escaped.md",
  ".hidden.md",
  ".trash",
  ".obsidian",
  ".daily-do-list",
  ".git",
  "link-out.md",
  "dir-out",
  "CON",
  "．．",
  "／",
  "\u2024",
  "e\u0301",
  "a b",
  "x.md",
  "x.md.",
  "x.md ",
  "\\",
  "\u0000",
  "\n",
  "\u202e",
  "%",
  "C:",
  "~",
);

type Encoding = "raw" | "lower" | "upper" | "double";

function encodeChar(ch: string, how: Encoding): string {
  const pct = (upper: boolean) =>
    [...Buffer.from(ch, "utf8")]
      .map((b) => `%${b.toString(16).padStart(2, "0")}`)
      .map((s) => (upper ? s.toUpperCase() : s))
      .join("");
  switch (how) {
    case "raw":
      return /^[A-Za-z0-9._~ -]$/.test(ch) ? ch : encodeURIComponent(ch);
    case "lower":
      return pct(false);
    case "upper":
      return pct(true);
    case "double":
      return pct(true).replaceAll("%", "%25");
  }
}

/** A note path built from hostile pieces, each character encoded in a random way. */
const encodedPath = fc
  .array(fc.tuple(piece, fc.constantFrom("/", "\\", "")), { minLength: 1, maxLength: 6 })
  .chain((parts) => {
    const chars = [...parts.map(([p, sep]) => `${p}${sep}`).join("")];
    return fc
      .tuple(
        fc.array(fc.constantFrom<Encoding>("raw", "raw", "raw", "lower", "upper", "double"), {
          minLength: chars.length,
          maxLength: chars.length,
        }),
        fc.boolean(),
      )
      .map(([encodings, keepSlashes]) =>
        chars
          .map((ch, i) => (keepSlashes && ch === "/" ? "/" : encodeChar(ch, encodings[i]!)))
          .join(""),
      );
  });

const DELETE_TARGETS = ["x.md", "Notes/x.md", "a b/x.md", "CON/x.md", "e\u0301/x.md"];

describe("fuzzed note paths", () => {
  test.prop([encodedPath, fc.constantFrom("GET", "PUT")], { numRuns: ioRuns(0.6) })(
    "never escape the vault, never touch hidden files, and never fail with 5xx",
    async (encoded, method) => {
      let res: Response | undefined;
      const changes = await diskChanges(async () => {
        res = await send(method, `/api/notes/${encoded}`, bodyFor(method, "fuzz"));
      });
      if (res!.status === 500) expect(somethingInTheWay(encoded), encoded).toBe(true);
      else expect([200, 201, 400, 404], `${method} ${encoded}`).toContain(res!.status);
      expect(forbiddenChanges(changes), `${method} ${encoded}`).toEqual([]);
      if (res!.ok) {
        const body = (await res!.json()) as { path: string; content?: string };
        expect(isHiddenPath(body.path)).toBe(false);
        if (method === "GET") expect(body.content).not.toContain("canary");
      }
    },
    ioTimeout(0.6),
  );

  test.prop([encodedPath], { numRuns: ioRuns(0.4) })(
    "DELETE only ever moves one visible note into vault/.trash",
    async (encoded) => {
      for (const path of DELETE_TARGETS) {
        if (!(await app.storage.stat(path))) await app.storage.write(path, "target");
      }
      let res: Response | undefined;
      const changes = await diskChanges(async () => {
        res = await send("DELETE", `/api/notes/${encoded}`);
      });
      expect([200, 400, 404], encoded).toContain(res!.status);
      if (res!.status !== 200) {
        expect(changes, encoded).toEqual([]);
        return;
      }
      const { trashedTo } = (await res!.json()) as { trashedTo: string };
      expect(trashedTo.startsWith(".trash/")).toBe(true);
      const outsideTrash = changes.filter(
        (path) => !path.startsWith("vault/.trash") && forbiddenChanges([path]).length > 0,
      );
      expect(outsideTrash, encoded).toEqual([]);
      expect(changes).toContain(`vault/${trashedTo}`);
    },
    ioTimeout(0.4),
  );
});

describe("rename, folders and query paths", () => {
  it("rejects hostile rename sources and targets without touching the disk", async () => {
    const changes = await diskChanges(async () => {
      for (const bad of HOSTILE_PATHS) {
        for (const body of [
          { from: bad, to: "Notes/renamed.md" },
          { from: "Notes/visible.md", to: bad },
          { from: bad, to: bad },
        ]) {
          const res = await send("POST", API_ROUTES.rename, body);
          expect([400, 404, 409], JSON.stringify(body)).toContain(res.status);
        }
      }
    });
    expect(changes).toEqual([]);
  });

  it("rejects hostile folder creation and deletion without touching the disk", async () => {
    const changes = await diskChanges(async () => {
      for (const bad of HOSTILE_PATHS) {
        const create = await send("POST", API_ROUTES.folders, { path: bad });
        expect([400, 409], `POST ${JSON.stringify(bad)}`).toContain(create.status);
        const del = await send("DELETE", `${API_ROUTES.folders}?path=${encodeURIComponent(bad)}`);
        expect([400, 404], `DELETE ${JSON.stringify(bad)}`).toContain(del.status);
      }
      expect((await send("DELETE", API_ROUTES.folders)).status).toBe(400);
    });
    expect(changes).toEqual([]);
  });

  it("rejects hostile notePath query parameters", async () => {
    // Symlinks only matter to storage; these filters never read the disk.
    for (const bad of HOSTILE_PATHS.filter((p) => p !== "" && !p.includes("-out"))) {
      for (const path of [
        API_ROUTES.tasks(bad),
        `${API_ROUTES.threads}?notePath=${encodeURIComponent(bad)}`,
      ]) {
        expect((await send("GET", path)).status, path).toBe(400);
      }
    }
  });

  it("rejects daily-note settings that point outside or into hidden folders", async () => {
    const changes = await diskChanges(async () => {
      for (const dailyNotes of [
        { folder: "../outside" },
        { folder: "Notes/../../outside" },
        { folder: ".trash" },
        { folder: ".daily-do-list" },
        { format: "[../../]YYYY-MM-DD" },
        { format: "[.hidden/]YYYY-MM-DD" },
        { template: ".daily-do-list/state/canary" },
      ]) {
        const put = await send("PUT", API_ROUTES.settings, { dailyNotes });
        if (put.ok) {
          const daily = await send("GET", API_ROUTES.daily("2031-01-02"));
          expect([200, 400], JSON.stringify(dailyNotes)).toContain(daily.status);
          if (daily.ok) expect(await daily.text()).not.toContain("canary");
        } else {
          expect(put.status, JSON.stringify(dailyNotes)).toBe(400);
        }
      }
    });
    const unexpected = forbiddenChanges(changes).filter(
      (p) => p !== "vault/.daily-do-list/settings.json",
    );
    expect(unexpected).toEqual([]);
  });
});

describe("artifact route identifiers", () => {
  it("only hands the runtime identifiers from the safe alphabet", async () => {
    const seen: Array<[string, string]> = [];
    const meta: ArtifactMeta = {
      id: "art_1",
      threadId: "thr_1",
      title: "Report",
      kind: "file",
      mimeType: "text/plain",
      path: ".daily-do-list/artifacts/thr_1/art_1.txt",
      size: 2,
      createdAt: 1,
    };
    runtime.readArtifact = async (threadId, artifactId) => {
      seen.push([threadId, artifactId]);
      return threadId === "thr_1" && artifactId === "art_1"
        ? { meta, body: new TextEncoder().encode("ok") }
        : null;
    };
    for (const [thread, artifact] of [
      ["..", "x"],
      ["%2e%2e", "x"],
      ["thr_1", "..%2F..%2Fsettings.json"],
      ["thr_1", "art_1%00"],
      ["thr_1", "art%2F1"],
      ["thr%5C1", "art_1"],
      ["thr_1", "a".repeat(201)],
      ["thr_1", "%C0%AE"],
      ["th%20r", "art_1"],
    ]) {
      const res = await send("GET", `/api/artifacts/${thread}/${artifact}`);
      expect([400, 404], `${thread}/${artifact}`).toContain(res.status);
    }
    expect((await send("GET", API_ROUTES.artifact("thr_1", "art_1"))).status).toBe(200);
    for (const [thread, artifact] of seen) {
      expect(thread).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);
      expect(artifact).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);
    }
  });
});

describe("resolveVaultPath", () => {
  test.prop([fc.string({ unit: "binary", maxLength: 300 })])(
    "returns a canonical, visible, in-vault path or throws a 400",
    (input) => {
      let path: string;
      try {
        path = resolveVaultPath(input);
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: "invalid_path" });
        return;
      }
      const controlOrBackslash = [...path].filter(
        (ch) => ch.charCodeAt(0) < 0x20 || ch === "\u007f" || ch === "\\",
      );
      expect(controlOrBackslash).toEqual([]);
      const badSegments = path
        .split("/")
        .filter((segment) => segment === "" || segment.startsWith(".") || segment.length > 255);
      expect(badSegments).toEqual([]);
      expect(resolveVaultPath(path)).toBe(path);
    },
  );

  it("rejects names longer than a file system allows, counting UTF-16 units like APFS", () => {
    expect(resolveVaultPath(`${"a".repeat(252)}.md`)).toHaveLength(255);
    expect(resolveVaultPath(`${"日".repeat(252)}.md`)).toHaveLength(255);
    for (const name of [
      `${"a".repeat(253)}.md`,
      `${"😀".repeat(127)}.md`,
      `x/${"b".repeat(256)}/y.md`,
    ]) {
      expect(() => resolveVaultPath(name)).toThrow(/too long/);
    }
  });
});

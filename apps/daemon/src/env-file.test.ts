import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "./env-file";
import { tempDir } from "./test-helpers";

describe("loadEnvFiles", () => {
  let dir: { path: string; cleanup: () => void } | undefined;
  afterEach(() => dir?.cleanup());

  it("never overrides set variables and lets later files fill blanks", () => {
    dir = tempDir();
    const first = join(dir.path, "first.env");
    const second = join(dir.path, "second.env");
    writeFileSync(first, "FROM_SHELL=file\nFIRST=1\nBLANK=\nSHARED=first\n");
    writeFileSync(second, "FIRST=2\nBLANK=filled\nSHARED=second\nSECOND=2\n");
    const env: Record<string, string | undefined> = { FROM_SHELL: "shell" };
    const loaded = loadEnvFiles([first, join(dir.path, "missing.env"), second], env);
    expect(loaded).toEqual([first, second]);
    expect(env).toEqual({
      FROM_SHELL: "shell",
      FIRST: "1",
      BLANK: "filled",
      SHARED: "first",
      SECOND: "2",
    });
  });
});

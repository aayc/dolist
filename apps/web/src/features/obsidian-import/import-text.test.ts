import type { ObsidianImportJob } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { HttpError, NetworkError } from "../../api/errors";
import {
  attachmentKinds,
  dailyNotesText,
  editorSettingsText,
  importProblem,
  joinWords,
  PAIRED_DEVICE_REASON,
  progressFraction,
  progressText,
} from "./import-text";

function job(
  progress: ObsidianImportJob["progress"],
  state: ObsidianImportJob["state"] = "running",
) {
  return {
    id: "imp_1",
    kind: "import",
    state,
    phase: "copying",
    source: "/Users/me/Obsidian Notebook",
    destination: "/Users/me/New",
    startedAt: 1,
    progress,
  } satisfies ObsidianImportJob;
}

describe("import wording", () => {
  it("says how far a job got, in files and bytes", () => {
    const halfway = job({ files: 32, totalFiles: 64, bytes: 1_572_864, totalBytes: 3_145_728 });
    expect(progressText(halfway)).toBe("32 of 64 files · 1.5 MB of 3.0 MB");
    expect(progressFraction(halfway)).toBe(0.5);
    expect(progressText(job({ files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 }))).toBe("");
    expect(
      progressFraction(job({ files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 }, "done")),
    ).toBe(1);
  });

  it("lists attachments by kind, and joins words like a sentence", () => {
    expect(
      attachmentKinds({
        count: 14,
        bytes: 1,
        byType: [
          { type: "image", count: 11, bytes: 1 },
          { type: "pdf", count: 1, bytes: 1 },
          { type: "other", count: 2, bytes: 1 },
        ],
      }),
    ).toBe("11 images, 1 PDF and 2 other files");
    expect(joinWords(["a"])).toBe("a");
    expect(joinWords([])).toBe("");
  });

  it("describes daily-note and editor settings found in Obsidian", () => {
    expect(dailyNotesText({ folder: "", format: "YYYY-MM-DD", template: "" })).toBe(
      "the vault's top folder, named YYYY-MM-DD",
    );
    expect(editorSettingsText({ vimMode: true, showLineNumbers: false }, true)).toEqual([
      "vim mode on",
      "line numbers off",
      "the vimrc",
    ]);
  });

  it("keeps the daemon's words, and says it plainly for a paired device or no answer", () => {
    const conflict = new HttpError(409, "An import or update is already running", {
      error: "conflict",
      message: "An import or update is already running",
    });
    expect(importProblem(conflict)).toEqual({
      message: "An import or update is already running",
      status: 409,
      code: "conflict",
    });
    const paired = new HttpError(403, "x", { error: "forbidden_device", message: "x" });
    expect(importProblem(paired)).toMatchObject({ message: PAIRED_DEVICE_REASON, status: 403 });
    expect(importProblem(new NetworkError("fetch failed")).message).toMatch(/didn't answer/);
  });
});

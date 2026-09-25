import type { ObsidianImportJob } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyImportJob,
  applyImportStatus,
  laterJob,
  useObsidianImportStore,
} from "./obsidian-import-store";

function job(patch: Partial<ObsidianImportJob> = {}): ObsidianImportJob {
  return {
    id: "imp_1",
    kind: "import",
    state: "running",
    phase: "copying",
    source: "/Users/me/Obsidian Notebook",
    destination: "/Users/me/Obsidian Notebook (Daily Do List)",
    startedAt: 1,
    progress: { files: 1, totalFiles: 4, bytes: 10, totalBytes: 40 },
    ...patch,
  };
}

afterEach(() => {
  useObsidianImportStore.setState({ job: null, imported: null });
});

describe("the import job the page shows", () => {
  it("keeps a job's end over a late running snapshot of it", () => {
    const done = job({ state: "done", phase: "finishing" });
    expect(laterJob(done, job())).toBe(done);
    expect(laterJob(job(), done)).toBe(done);
  });

  it("takes any snapshot of another job, and a cleared one", () => {
    const next = job({ id: "imp_2" });
    expect(laterJob(job({ state: "done" }), next)).toBe(next);
    expect(laterJob(job(), null)).toBeNull();
  });

  it("follows events and status answers, and where the vault came from", () => {
    applyImportJob(job());
    applyImportStatus({
      job: job({ state: "cancelled" }),
      imported: { source: "/Users/me/Obsidian Notebook", importedAt: 5 },
    });
    applyImportJob(job());
    expect(useObsidianImportStore.getState()).toMatchObject({
      job: { state: "cancelled" },
      imported: { importedAt: 5 },
    });
    applyImportStatus({ job: null });
    expect(useObsidianImportStore.getState()).toEqual({ job: null, imported: null });
  });
});

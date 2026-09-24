import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CloudExecutionProvider,
  createExecutionProvider,
  createExecutionTools,
  LocalExecutionProvider,
  NotImplementedError,
} from "./index";

describe("createExecutionProvider", () => {
  it("builds the local provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "ddl-registry-"));
    try {
      const provider = await createExecutionProvider({
        kind: "local",
        home,
        computer: { enabled: false },
      });
      expect(provider).toBeInstanceOf(LocalExecutionProvider);
      expect(provider.id).toBe("local");
      expect(provider.capabilities).toMatchObject({ shell: true, computer: false });
      const workspace = await provider.prepareWorkspace("thr_1");
      expect(workspace.dir).toBe(join(home, "workspaces", "thr_1"));
      const tools = createExecutionTools(provider, {
        threadId: "thr_1",
        taskId: null,
        workspace,
        capabilities: ["shell"],
      });
      expect(tools).toEqual([]);
      await provider.dispose();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("builds the cloud stub", async () => {
    const provider = await createExecutionProvider({
      kind: "cloud",
      endpoint: "https://sandbox.example.com",
      apiKeyEnv: "DDL_CLOUD_API_KEY",
    });
    expect(provider).toBeInstanceOf(CloudExecutionProvider);
    await expect(provider.prepareWorkspace("x")).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("rejects unknown kinds", async () => {
    await expect(
      createExecutionProvider({ kind: "mainframe" } as unknown as Parameters<
        typeof createExecutionProvider
      >[0]),
    ).rejects.toThrow(/Unknown execution provider/);
  });
});

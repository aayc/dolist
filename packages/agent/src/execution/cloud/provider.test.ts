import { describe, expect, it } from "vitest";
import { NotImplementedError } from "../errors";
import { CloudExecutionProvider } from "./provider";

describe("CloudExecutionProvider (stub)", () => {
  const provider = new CloudExecutionProvider({
    kind: "cloud",
    endpoint: "https://sandbox.example.com",
    apiKeyEnv: "DDL_CLOUD_API_KEY",
  });

  it("advertises no capabilities and no controllers", () => {
    expect(provider.id).toBe("cloud");
    expect(provider.capabilities).toEqual({ shell: false, browser: false, computer: false });
    expect(provider.browser).toBeUndefined();
    expect(provider.computer).toBeUndefined();
  });

  it("throws NotImplementedError from its operations", async () => {
    await expect(provider.shell.exec("echo hi", { cwd: "/" })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(provider.prepareWorkspace("thread")).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("disposes cleanly", async () => {
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});

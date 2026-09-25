// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockDaemonClient } from "../../api/mock/mock-client";
import type { Services } from "../../app/services";
import { ServicesContext } from "../../app/services";
import { CommandRegistry } from "../../commands/registry";
import { applyImportJob, useObsidianImportStore } from "../../state/obsidian-import-store";
import { ui } from "../../state/ui-store";
import { VaultSection } from "./VaultSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../app/lazy", () => ({ VaultSwitchOverlay: { preload: async () => {} } }));

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  useObsidianImportStore.setState({ job: null, imported: null });
  ui.set({ overlay: null });
});

function render(
  client = new MockDaemonClient({ installHooks: false, persistSettings: false, importStepMs: 5 }),
) {
  client.onEvent((event) => {
    if (event.type === "import.progress") applyImportJob(event.job);
  });
  client.connect();
  const flushAll = vi.fn(async () => {});
  const services = {
    client,
    commands: new CommandRegistry(),
    workspace: { notes: { flushAll } },
  } as unknown as Services;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(
      <ServicesContext value={services}>
        <VaultSection />
      </ServicesContext>,
    );
  });
  const one = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { client, container, one, flushAll };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings → Vault", () => {
  it("previews, imports with progress, and switches after saving open notes", async () => {
    const { client, one, flushAll } = render();
    await until(() => one("vault-current")?.textContent?.includes("Demo Vault") ?? false, "vault");
    type(one("import-source") as HTMLInputElement, "~/Obsidian Notebook");
    act(() => one("import-preview")!.click());
    await until(() => one("import-report") !== null, "the report");
    expect(one("report-watched-tasks")?.textContent).toContain("3 open tasks");
    expect((one("import-destination") as HTMLInputElement).value).toBe(
      "/Users/me/Obsidian Notebook (Daily Do List)",
    );

    act(() => one("import-start")!.click());
    await until(() => one("import-progress") !== null, "progress");
    await until(() => one("import-result") !== null, "the result");
    expect(one("import-result")?.textContent).toContain("64 files");

    const switchVault = vi.spyOn(client, "switchVault");
    act(() => one("switch-vault")!.click());
    await until(() => ui.get().overlay?.kind === "vault-switch", "the switch overlay");
    expect(flushAll.mock.invocationCallOrder[0]).toBeLessThan(
      switchVault.mock.invocationCallOrder[0]!,
    );
    expect(ui.get().overlay).toEqual({
      kind: "vault-switch",
      path: "/Users/me/Obsidian Notebook (Daily Do List)",
      restart: "supervisor",
    });
  });

  it("says why a path can't be read, and a second import can't start while one runs", async () => {
    const { client, one } = render();
    type(one("import-source") as HTMLInputElement, "/Users/me/Nope");
    act(() => one("import-preview")!.click());
    await until(() => one("import-problem") !== null, "the problem");
    expect(one("import-problem")?.textContent).toBe("There's no folder at /Users/me/Nope");

    await client.startObsidianImport({ source: "~/Plain notes" });
    type(one("import-source") as HTMLInputElement, "~/Obsidian Notebook");
    await until(() => one("import-progress") !== null, "the running job shows");
    expect(one("import-cancel")).not.toBeNull();
  });

  it("offers Update from Obsidian and shows the old vault once this vault was imported", async () => {
    const client = new MockDaemonClient({
      installHooks: false,
      persistSettings: false,
      importStepMs: 5,
      restartMs: 5,
    });
    client.connect();
    const { job } = await client.startObsidianImport({ source: "~/Obsidian Notebook" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await client.switchVault(job.destination);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { one } = render(client);
    await until(() => one("vault-imported") !== null, "the import's origin");
    expect(one("vault-imported")?.textContent).toContain("/Users/me/Obsidian Notebook");
    expect(one("vault-previous")?.textContent).toContain("/Users/me/Demo Vault");
    act(() => one("vault-update")!.click());
    await until(() => one("update-report") !== null, "the update's report");
    expect(one("update-report")?.textContent).toContain("1 new, 1 changed");
  });

  it("disables everything on a paired device, and says why", async () => {
    const client = new MockDaemonClient({ installHooks: false, persistSettings: false });
    client.testHooks().setPairedDevice(true);
    const { one, container } = render(client);
    await until(() => one("vault-forbidden") !== null, "the reason");
    expect((one("import-source") as HTMLInputElement).disabled).toBe(true);
    expect(
      container.querySelector("[data-testid='disabled-reason']")?.getAttribute("data-tooltip"),
    ).toMatch(/Only the Mac/);
  });
});

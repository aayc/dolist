/**
 * Drawings end to end (fake brain in-process, real runtime and safety stack): the orchestrator
 * reads a drawing's description in its digest and hands it to the subagent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAgentRuntime, type FakeAgentRuntime } from "../../src/testing";
import { flowchartDrawing } from "../../src/testing/drawings";
import { expectAllGated } from "./helpers";

const active: FakeAgentRuntime[] = [];

vi.setConfig({ testTimeout: 15_000 });
afterEach(async () => {
  for (const t of active.splice(0)) await t.stop();
});

async function runtime(): Promise<FakeAgentRuntime> {
  const t = await createFakeAgentRuntime();
  active.push(t);
  return t;
}

describe("drawings: the orchestrator uses what the digest describes", () => {
  it("implements the flow in the diagram from the drawing's description", async () => {
    const t = await runtime();
    await t.storage.write(
      "Excalidraw/Signup.excalidraw.md",
      flowchartDrawing({
        boxes: ["Landing", "Sign up form", "Verify email", "Dashboard"],
        arrows: [
          ["Landing", "Sign up form"],
          ["Sign up form", "Verify email", "submit"],
          ["Verify email", "Dashboard"],
        ],
      }),
    );
    const task = "Implement the flow in the diagram";
    await t.writeDailyNote([`- [ ] ${task}`, "![[Signup.excalidraw|360|right-wrap]]"]);
    await t.waitForStatus(task, "done");
    expect(t.digests().join("\n")).toContain("⟪drawing⟫ Excalidraw/Signup.excalidraw.md");
    const spawn = t.audit.gate.find((g) => g.toolName === "spawn_subagent");
    const instructions = (spawn!.input as { instructions?: string }).instructions ?? "";
    expect(instructions).toContain("The drawing Excalidraw/Signup.excalidraw.md");
    expect(instructions).toContain(
      "Arrows: “Landing” → “Sign up form”, “Sign up form” → “Verify email” labeled “submit”, “Verify email” → “Dashboard”",
    );
    expectAllGated(t);
  });

  it("describes the drawings under a task in its subagent's kickoff", async () => {
    const t = await runtime();
    await t.storage.write(
      "Excalidraw/Garden.excalidraw.md",
      flowchartDrawing({ boxes: ["Tomatoes", "Basil"], notes: ["South fence"] }),
    );
    const task = "Research companion plants for this bed";
    await t.writeDailyNote([`- [ ] ${task}`, "  - ![[Garden.excalidraw]]"]);
    await t.waitForStatus(task, "done");
    const kickoff = t.kickoffs().find((k) => k.includes(`Task: ${JSON.stringify(task)}`)) ?? "";
    expect(kickoff).toContain("Drawings in the task:\n⟪drawing⟫ Excalidraw/Garden.excalidraw.md");
    expect(kickoff).toContain("  Shapes: rectangle “Tomatoes”, rectangle “Basil”");
    expectAllGated(t);
  });
});

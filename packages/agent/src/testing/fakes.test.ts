import { silentLogger, toolResultText } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { createExecutionTools } from "../execution";
import { LlmError } from "../llm/types";
import { createLlmJudge } from "../safety/llm-judge";
import { createFakeBrain } from "./brain/brain";
import {
  createFakeConnectors,
  createFakeExecution,
  createFakeWeb,
  createFakeWebTools,
} from "./fakes";
import { createFakeLlmClient } from "./llm-client";

const ctx = { toolCallId: "c1" };

describe("fake web", () => {
  it("serves generated pages to the real web_fetch, and configured ones by URL", async () => {
    const web = createFakeWeb({ "https://www.example.com/broken": { status: 503, body: "down" } });
    const [fetchTool] = createFakeWebTools({ web });
    const ok = await fetchTool!.execute({ url: "https://www.example.com/robot-vacuums" }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(toolResultText(ok)).toContain("Option A — the best all-rounder");
    const broken = await fetchTool!.execute({ url: "https://www.example.com/broken" }, ctx);
    expect(broken.isError).toBe(true);
    expect(toolResultText(broken)).toContain("HTTP 503");
    const blocked = await fetchTool!.execute({ url: "http://127.0.0.1/admin" }, ctx);
    expect(toolResultText(blocked)).toMatch(/private or reserved/);
    expect(web.fetched).toEqual([
      "https://www.example.com/robot-vacuums",
      "https://www.example.com/broken",
    ]);
  });

  it("web_search runs through the brain as an LLM client, with citations", async () => {
    const tools = createFakeWebTools({ llm: createFakeLlmClient(createFakeBrain()) });
    const search = tools.find((t) => t.name === "web_search")!;
    const result = await search.execute({ query: "standing desks" }, ctx);
    expect(toolResultText(result)).toContain(
      "Sources:\n1. [Standing desks — guide](https://www.example.com/guides/standing-desks)",
    );
  });
});

describe("fake browser and execution", () => {
  it("records actions and irreversible effects behind the real browser tools", async () => {
    const execution = createFakeExecution({ browser: true });
    const frames: unknown[] = [];
    const tools = createExecutionTools(execution, {
      threadId: "thr_1",
      taskId: "tsk_1",
      workspace: { key: "thr_1", dir: "/tmp/w" },
      capabilities: ["browser"],
      onFrame: (_surface, frame) => frames.push(frame),
    });
    const byName = (name: string) => tools.find((t) => t.name === name)!;
    const page = await byName("browser_navigate").execute({ url: "https://shop.example.com" }, ctx);
    expect(toolResultText(page)).toContain('- button "Place order" [ref=e5]');
    await byName("browser_click").execute({ ref: "e4", element: "Add to cart button" }, ctx);
    expect(execution.browser!.effects).toEqual([]);
    await byName("browser_click").execute({ ref: "e5", element: "Place order button" }, ctx);
    expect(execution.browser!.effects).toEqual([
      { threadKey: "thr_1", action: "Place order", url: "https://shop.example.com" },
    ]);
    expect(execution.browser!.actions).toEqual([
      "navigate https://shop.example.com",
      "click Add to cart",
      "click Place order",
    ]);
    expect(frames).toHaveLength(3);
  });

  it("records shell commands and creates real workspaces on request", async () => {
    const execution = createFakeExecution({
      shellOutput: (cmd) => ({ output: `custom ${cmd}`, exitCode: 2 }),
    });
    const result = await execution.shell.exec("ls", { cwd: "/tmp" });
    expect(result).toMatchObject({ output: "custom ls", exitCode: 2 });
    expect(execution.commands).toEqual([{ command: "ls", cwd: "/tmp" }]);
    expect((await execution.prepareWorkspace("thr_2")).dir).toBe("/tmp/ddl-fake-workspaces/thr_2");
  });
});

describe("fake connectors", () => {
  it("expose real MCP tool specs; writes are recorded as effects", async () => {
    const connectors = createFakeConnectors();
    const tools = await connectors.getTools();
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__mail__search_inbox",
      "mcp__mail__send_email",
      "mcp__calendar__list_events",
    ]);
    const send = tools.find((t) => t.name === "mcp__mail__send_email")!;
    expect(send.safety).toMatchObject({ readOnly: false, openWorld: true, destructive: false });
    expect(send.safety.describe?.({ to: "a@example.com" })).toBe(
      'mail · send_email(to: "a@example.com")',
    );
    await tools[0]!.execute({ query: "x" }, ctx);
    await send.execute({ to: "a@example.com", subject: "s", body: "b" }, ctx);
    expect(connectors.calls).toHaveLength(2);
    expect(connectors.effects).toEqual([
      {
        server: "mail",
        tool: "send_email",
        args: { to: "a@example.com", subject: "s", body: "b" },
      },
    ]);
    connectors.setState("mail", "error");
    expect(connectors.status()[0]).toMatchObject({ name: "mail", state: "error" });
    expect((await connectors.getTools()).map((t) => t.name)).toEqual([
      "mcp__calendar__list_events",
    ]);
  });
});

describe("in-process LLM client", () => {
  it("feeds the real judge schema-valid verdicts", async () => {
    const llm = createFakeLlmClient(createFakeBrain());
    const judge = createLlmJudge({ llm, timeoutMs: 1_000, logger: silentLogger });
    const verdict = await judge.judge({
      ctx: {
        toolName: "bash",
        input: { command: "rm -rf /" },
        hints: {},
        role: "subagent",
        taskId: null,
        threadId: null,
      },
      summary: "Run rm -rf /",
      input: { command: "rm -rf /" },
      signals: [],
    });
    expect(verdict).toMatchObject({ decision: "deny", source: "llm", risk: "critical" });
    expect(llm.calls[0]).toMatchObject({
      purpose: "safety-judge",
      jsonSchema: { name: "safety_verdict" },
    });
  });

  it("turns brain failures into LlmErrors and honors aborts", async () => {
    const brain = createFakeBrain().fail({ status: 429, message: "slow down" }).hang();
    const llm = createFakeLlmClient(brain);
    const error = await llm
      .complete({ messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 429, retryable: true });
    const controller = new AbortController();
    const pending = llm.complete({
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: "Request aborted" });
  });
});

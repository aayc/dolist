/**
 * Full stack over HTTP: the real Pi harness and the real OpenRouter client talk to the fake
 * OpenRouter server (streaming SSE, tool calls, web plugin, judge), with the real runtime and
 * safety stack around them. No artificial latency; faults are injected per request.
 */
import { describe, expect, it } from "vitest";
import { createFakeConnectors, type RecordedRequest, startFakeOpenRouter } from "../../src/testing";
import { expectAllGated, fakeRuntime, gatedToolsOf, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

const isSubagentRequest = (r: RecordedRequest) =>
  JSON.stringify(r.body ?? {}).includes('"finish_task"');
const isOrchestratorRequest = (r: RecordedRequest) =>
  JSON.stringify(r.body ?? {}).includes('"spawn_subagent"');

describe("pi-http: the real harness against the fake OpenRouter", () => {
  it("delegates and finishes, streaming text deltas into the thread", async () => {
    const t = await fakeRuntime({ via: "pi-http" });
    const task = "Research best standing desks under $500";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const thread = t.thread(task);
    const deltas = t.events.filter(
      (e) => e.type === "thread.delta" && e.payload.threadId === thread.id,
    );
    expect(deltas.length).toBeGreaterThan(2);
    expect(t.texts(task)).toContain(
      "Looking into “Research best standing desks under $500” — gathering a few options first.",
    );
    expect(gatedToolsOf(t, task)).toEqual([
      "post_update",
      "web_search",
      "web_fetch",
      "create_artifact",
      "edit_note",
      "finish_task",
    ]);

    const server = t.server!;
    const chats = server.chatRequests();
    const streamed = chats.filter((r) => r.stream);
    expect(streamed.every((r) => r.headers.authorization === `Bearer ${server.apiKey}`)).toBe(true);
    expect(streamed.every((r) => r.headers["x-title"] === "Daily Do List")).toBe(true);
    expect(
      streamed.every((r) => (r.body as { model: string }).model === t.settings.agent.model),
    ).toBe(true);
    // Session affinity: one id per harness session, reused across its requests.
    const sessionIds = (match: (r: RecordedRequest) => boolean) =>
      new Set(streamed.filter(match).map((r) => r.headers["x-session-id"]));
    expect(sessionIds(isOrchestratorRequest).size).toBe(1);
    expect(sessionIds(isSubagentRequest).size).toBe(1);
    expect([...sessionIds(isOrchestratorRequest)][0]).not.toBe(
      [...sessionIds(isSubagentRequest)][0],
    );
    const orchestrator = streamed.find(isOrchestratorRequest)!;
    expect((orchestrator.body as { reasoning?: unknown }).reasoning).toEqual({ effort: "low" });
    // web_search went through the one-shot client and the web plugin.
    const search = chats.find((r) => !r.stream && JSON.stringify(r.body).includes('"plugins"'));
    expect((search!.body as { plugins: unknown }).plugins).toEqual([{ id: "web", max_results: 3 }]);
    expect(search!.turn?.citations?.length).toBe(3);
    expect(chats.every((r) => r.status === 200 && r.completed)).toBe(true);
    expectAllGated(t);
  });

  it("pauses for approval through Pi and completes after approval", async () => {
    const t = await fakeRuntime({ via: "pi-http", execution: { browser: true } });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const approval = await t.waitForApproval();
    expect(approval).toMatchObject({ toolName: "browser_click", categories: ["payment"] });
    expect(t.execution.browser!.effects).toEqual([]);
    await t.approveNext();
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Ordered (mock)");
    expect(t.execution.browser!.effects).toHaveLength(1);
    expectAllGated(t);
  });

  it("a restart mid-approval restores the Pi session from the journal, which asks again", async () => {
    const t = await fakeRuntime({ via: "pi-http", execution: { browser: true } });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const first = await t.waitForApproval();
    const server = t.server!;
    const before = server.chatRequests().length;

    await t.restart();
    const again = await t.waitForApproval();
    expect(again.id).not.toBe(first.id);
    const restored = server
      .chatRequests()
      .slice(before)
      .find((r) => r.stream && isSubagentRequest(r))!;
    const messages = (restored.body as { messages: Array<{ role: string; content?: unknown }> })
      .messages;
    const text = (m: { content?: unknown }) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    // The whole conversation came back: the kickoff, the calls made and their results, then the
    // note that the agent restarted.
    expect(messages.filter((m) => m.role === "user").map(text)[0]).toContain(`Task: "${task}"`);
    expect(messages.some((m) => m.role === "tool")).toBe(true);
    expect(text(messages.at(-1)!)).toContain("The agent restarted while you were working");
    expect(t.execution.browser!.effects).toEqual([]);

    await t.approveNext();
    await t.waitForStatus(task, "done");
    expect(t.execution.browser!.effects).toHaveLength(1);
    expect(t.kickoffs()).toHaveLength(1);
    expectAllGated(t);
  });

  it("a tool the policy blocks is refused by Pi and reported by the agent", async () => {
    const t = await fakeRuntime({
      via: "pi-http",
      execution: { browser: true },
      safetyPolicy: { alwaysDenyTools: ["browser_click"] },
    });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "waiting_user");
    expect(record.summary).toBe("Not approved");
    expect(t.runtime.listApprovals()).toEqual([]);
    expect(t.execution.browser!.effects).toEqual([]);
    const sawBlock = t
      .server!.chatRequests()
      .some((r) =>
        r.brainRequest?.messages.some(
          (m) =>
            m.role === "tool" &&
            m.content.startsWith("Blocked by safety policy: browser_click is blocked"),
        ),
      );
    expect(sawBlock).toBe(true);
    expect(t.toolCalls(task).find((m) => m.toolName === "browser_click")?.status).toBe("blocked");
    expectAllGated(t);
  });

  it("runs parallel tool calls from one assistant turn", async () => {
    const t = await fakeRuntime({ via: "pi-http" });
    await t.writeDailyNote([
      "- [ ] Research standing desks",
      "- [ ] What's the capital of Canada?",
      "- [ ] Call mom",
    ]);
    await t.waitForStatus("Research standing desks", "done");
    await t.waitForStatus("What's the capital of Canada?", "done");
    await t.waitForStatus("Call mom", "ignored");
    const first = t.server!.chatRequests().find(isOrchestratorRequest)!;
    expect(first.toolCalls.map((c) => c.name).sort()).toEqual([
      "post_comment",
      "post_comment",
      "set_task_status",
      "set_task_status",
      "spawn_subagent",
    ]);
    const ids = new Set(first.toolCalls.map((c) => c.id));
    const executed = t.audit.gate.filter((g) => ids.has(g.toolCallId));
    expect(executed).toHaveLength(5);
    expect(executed.every((g) => g.decision?.allow)).toBe(true);
  });

  it("retries a 429 (Retry-After: 0) and succeeds", async () => {
    const t = await fakeRuntime({
      via: "pi-http",
      faults: [{ kind: "status", status: 429, retryAfter: 0 }],
    });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const chats = t.server!.chatRequests();
    expect(chats[0]).toMatchObject({ status: 429, fault: "status" });
    expect(chats[1]?.status).toBe(200);
    expect(t.runtime.status().problem).toBeUndefined();
  });

  it("a persistent 500 fails the task with a helpful error, and retry recovers", async () => {
    const t = await fakeRuntime({ via: "pi-http" });
    t.server!.inject({ kind: "status", status: 500, message: "upstream exploded" }, { times: 2 });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const failed = await t.waitForStatus(task, "failed");
    expect(failed.summary).toBe("Couldn't triage");
    expect(t.runtime.status().problem).toMatch(/500/);
    const note = t.messages(task).find((m) => m.kind === "status" && m.status === "failed");
    expect(note?.kind === "status" && note.text).toMatch(/upstream exploded/);
    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus(task, "done");
  });

  it("invalid tool arguments are rejected by Pi's validation, shown to the model, and re-issued", async () => {
    const t = await fakeRuntime({ via: "pi-http" });
    t.brain.corruptToolArgs({ tool: "create_artifact", mode: "schema" });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const validation = t
      .server!.chatRequests()
      .some((r) =>
        r.brainRequest?.messages.some(
          (m) =>
            m.role === "tool" &&
            m.content.startsWith('Validation failed for tool "create_artifact"'),
        ),
      );
    expect(validation).toBe(true);
    expect(t.audit.gate.filter((g) => g.toolName === "create_artifact")).toHaveLength(1);
    expectAllGated(t);
  });

  it("malformed JSON arguments are caught the same way", async () => {
    const t = await fakeRuntime({ via: "pi-http" });
    t.brain.corruptToolArgs({ tool: "post_update", mode: "invalid-json" });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const wire = t
      .server!.chatRequests()
      .flatMap((r) => r.toolCalls)
      .find((c) => c.name === "post_update");
    expect(() => JSON.parse(wire!.arguments)).toThrow();
  });

  it("cancelling mid-stream aborts the model request", async () => {
    const server = await startFakeOpenRouter({ chunkChars: 4 });
    server.inject({ kind: "slow", chunkDelayMs: 25 }, { match: isSubagentRequest });
    const t = await fakeRuntime({ via: "pi-http", server, brain: server.brain! });
    try {
      const task = "Research standing desks";
      await t.writeDailyNote([`- [ ] ${task}`]);
      await t.waitFor(() => t.events.some((e) => e.type === "thread.delta"), {
        what: "the first streamed delta",
      });
      await t.runtime.cancelThread(t.thread(task).id);
      await t.waitForStatus(task, "cancelled");
      await t.waitFor(() => server.chatRequests().find((r) => isSubagentRequest(r) && r.aborted), {
        what: "the server to see the aborted request",
      });
      expect(t.messages(task).every((m) => m.kind !== "text" || !m.streaming)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("the runtime's own live wiring targets the fake (key check, harness)", async () => {
    const t = await fakeRuntime({ via: "pi-http", runtimeHarness: true });
    expect(t.runtime.status().problem).toBeUndefined();
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const key = t.server!.requests.find((r) => r.endpoint === "key");
    expect(key).toMatchObject({ status: 200, authorized: true });
    expect(t.server!.chatRequests().some((r) => r.stream)).toBe(true);
  });

  it("a rejected key (401) starts the agent degraded with an actionable problem", async () => {
    const t = await fakeRuntime({
      via: "pi-http",
      runtimeHarness: true,
      server: { keyValid: false },
    });
    expect(t.runtime.status().problem).toBe(
      "OpenRouter rejected OPENROUTER_API_KEY (401: User not found.). Put a valid key in ~/.daily-do-list/.env and restart.",
    );
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.records()).toEqual([]);
    expect(t.server!.chatRequests()).toEqual([]);
  });

  it("asks the judge over HTTP for actions the rules can't classify", async () => {
    const t = await fakeRuntime({
      via: "pi-http",
      connectors: createFakeConnectors({
        servers: [
          {
            name: "crm",
            tools: [
              {
                name: "tag_contact",
                description: "Add a tag to a contact.",
                inputSchema: {
                  type: "object",
                  properties: { contact: { type: "string" } },
                  required: ["contact"],
                },
                annotations: { destructiveHint: false, openWorldHint: false },
              },
            ],
          },
        ],
      }),
    });
    t.brain.when(
      (_request, info) =>
        info.role === "subagent" && info.callsSinceUser.at(-1)?.name === "post_update",
      { toolCalls: [{ name: "mcp__crm__tag_contact", arguments: { contact: "Sam Example" } }] },
      { times: 1 },
    );
    const task = "Tag the landlord in the CRM";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const judge = t
      .server!.chatRequests()
      .find((r) => JSON.stringify(r.body).includes('"safety_verdict"'));
    expect(judge?.body).toMatchObject({
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: "safety_verdict", strict: true },
      },
      provider: { require_parameters: true },
      reasoning: { effort: "none" },
    });
    expect(t.audit.gate.find((g) => g.toolName === "mcp__crm__tag_contact")?.verdict).toMatchObject(
      {
        decision: "allow",
        source: "llm",
      },
    );
    expectAllGated(t);
  });
});

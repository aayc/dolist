/**
 * Live mode without HTTP (scripted harness + the brain as an in-process LlmClient): the real web
 * tools on a fake network, the real browser tools on a fake browser, MCP connector tools, the LLM
 * judge, and the sandboxed brain. Irreversible effects must only appear after approval.
 */
import { describe, expect, it } from "vitest";
import { createFakeBrain, createFakeConnectors } from "../../src/testing";
import { expectAllGated, fakeRuntime, gatedToolsOf, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

describe("live mode (in-process)", () => {
  it("researches with the real web tools and cites what it found", async () => {
    const t = await fakeRuntime({ mode: "live" });
    const task = "Compare flights to Denver for Thanksgiving";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    expect(gatedToolsOf(t, task)).toEqual([
      "post_update",
      "web_search",
      "web_fetch",
      "create_artifact",
      "finish_task",
    ]);
    const search = t.toolCalls(task).find((m) => m.toolName === "web_search");
    expect(search).toMatchObject({ status: "ok", label: "Search the web" });
    expect(search?.resultPreview).toContain(
      "https://www.example.com/guides/compare-flights-to-denver-for-thanksgiving",
    );
    expect(t.web.fetched).toEqual([
      "https://www.example.com/guides/compare-flights-to-denver-for-thanksgiving",
    ]);
    expect(t.runtime.status()).toMatchObject({ mode: "live", model: t.settings.agent.model });
    expect(t.runtime.status().problem).toBeUndefined();
    expectAllGated(t);
  });

  it("buys through the real browser tools only after approval", async () => {
    const t = await fakeRuntime({ mode: "live", execution: { browser: true } });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const approval = await t.waitForApproval();
    expect(approval).toMatchObject({
      toolName: "browser_click",
      input: { ref: "e5", element: "Place order button" },
      categories: ["payment"],
      risk: "high",
    });
    expect(t.execution.browser!.effects).toEqual([]);
    expect(t.execution.browser!.actions).toEqual([
      "navigate https://shop.example.com/search?q=order-printer-ink-hp-63xl",
    ]);
    await t.approveNext();
    await t.waitForStatus(task, "done");
    expect(t.execution.browser!.effects).toMatchObject([{ action: "Place order" }]);
    expect(t.thread(task).surfaces).toEqual(["browser"]);
    expectAllGated(t);
  });

  it("a denied purchase never reaches the site", async () => {
    const t = await fakeRuntime({ mode: "live", execution: { browser: true } });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.denyNext("Wrong model");
    await t.waitForStatus(task, "waiting_user");
    expect(t.execution.browser!.effects).toEqual([]);
    expect(t.execution.browser!.actions.some((a) => a.startsWith("click"))).toBe(false);
  });

  it("sends email through an MCP connector only after approval", async () => {
    const t = await fakeRuntime({ mode: "live", connectors: true });
    const task = "Email landlord about the leaky faucet";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const spawn = await t.waitFor(() => t.audit.gate.find((g) => g.toolName === "spawn_subagent"), {
      what: "the spawn",
    });
    expect((spawn.input as { capabilities: string[] }).capabilities).toEqual(["connectors"]);
    const approval = await t.waitForApproval();
    expect(approval.toolName).toBe("mcp__mail__send_email");
    expect(approval.categories).toContain("communication");
    expect(t.connectors!.effects).toEqual([]);
    await t.approveNext();
    await t.waitForStatus(task, "done");
    expect(t.connectors!.effects).toMatchObject([
      { server: "mail", tool: "send_email", args: { to: "recipient@example.com" } },
    ]);
    expectAllGated(t);
  });

  it("falls back to what is available when the ideal capability isn't (no connectors → files)", async () => {
    const t = await fakeRuntime({ mode: "live" });
    const task = "Email landlord about the leaky faucet";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "waiting_user");
    const spawn = t.audit.gate.find((g) => g.toolName === "spawn_subagent");
    expect((spawn!.input as { capabilities: string[] }).capabilities).toEqual(["web"]);
    expect(record.summary).toBe("Ready for you");
    expect(t.texts(task).at(-1)).toContain("I can't email from here — the last step is yours.");
  });

  it("asks the LLM judge about connector actions the rules can't classify", async () => {
    const connectors = createFakeConnectors({
      servers: [
        {
          name: "crm",
          tools: [
            {
              name: "tag_contact",
              description: "Add a tag to a contact.",
              inputSchema: {
                type: "object",
                properties: { contact: { type: "string" }, tag: { type: "string" } },
                required: ["contact", "tag"],
              },
              annotations: { destructiveHint: false, openWorldHint: false },
            },
          ],
        },
      ],
    });
    const t = await fakeRuntime({ mode: "live", connectors });
    t.brain.when(
      (_request, info) =>
        info.role === "subagent" && info.callsSinceUser.at(-1)?.name === "post_update",
      {
        toolCalls: [
          { name: "mcp__crm__tag_contact", arguments: { contact: "Sam Example", tag: "landlord" } },
        ],
      },
      { times: 1, name: "tag the contact" },
    );
    const task = "Update the landlord's contact card in the CRM";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const tagged = t.audit.gate.find((g) => g.toolName === "mcp__crm__tag_contact");
    expect(tagged?.verdict).toMatchObject({ decision: "allow", source: "llm" });
    const judge = t.brain.decisions.filter((d) => d.role === "judge");
    expect(judge).toHaveLength(1);
    expect(judge[0]!.request.responseFormat?.name).toBe("safety_verdict");
    expect(judge[0]!.request.messages[0]?.content).toContain("tool: mcp__crm__tag_contact");
    expect(connectors.effects).toMatchObject([{ tool: "tag_contact" }]);
    expectAllGated(t);
  });

  it("the judge's escalation turns an unclassified action into an approval", async () => {
    const t = await fakeRuntime({
      mode: "live",
      connectors: createFakeConnectors({
        servers: [
          {
            name: "billing",
            tools: [
              {
                name: "settle_invoice",
                description: "Mark an invoice as settled.",
                inputSchema: {
                  type: "object",
                  properties: { invoice: { type: "string" } },
                  required: ["invoice"],
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
      { toolCalls: [{ name: "mcp__billing__settle_invoice", arguments: { invoice: "INV-1042" } }] },
      { times: 1 },
    );
    const task = "Tidy up the billing records in the CRM";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const approval = await t.waitForApproval();
    expect(approval.toolName).toBe("mcp__billing__settle_invoice");
    expect(t.audit.gate.find((g) => g.toolName === approval.toolName)?.verdict?.source).toBe("llm");
    await t.denyNext();
    await t.waitForStatus(task, "done");
  });

  it("the sandboxed brain never touches the browser or connectors, even when available", async () => {
    const t = await fakeRuntime({
      mode: "live",
      brain: createFakeBrain({ sandbox: true }),
      execution: { browser: true },
      connectors: true,
    });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "waiting_user");
    expect(record.summary).toBe("Ready for you");
    expect(t.execution.browser!.actions).toEqual([]);
    expect(t.connectors!.calls).toEqual([]);
    expect(t.web.fetched).toEqual([]);
    const spawn = t.audit.gate.find((g) => g.toolName === "spawn_subagent");
    expect((spawn!.input as { capabilities: string[] }).capabilities).toEqual(["web"]);
  });

  it("with simulated actions enabled, live subagents get the mock irreversible tool", async () => {
    const t = await fakeRuntime({
      mode: "live",
      brain: createFakeBrain({ sandbox: true }),
      overrides: { mockActions: true },
    });
    const task = "Order printer ink (HP 63XL)";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const approval = await t.waitForApproval();
    expect(approval.toolName).toBe("mock_irreversible_action");
    await t.approveNext();
    await t.waitForStatus(task, "done");
  });
});

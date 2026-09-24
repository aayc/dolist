/**
 * Property tests of the daemon against the contract: arbitrary valid runtime and vault data comes
 * back unchanged and conformant; arbitrary valid bodies are never rejected by validation; invalid
 * bodies, queries and paths are rejected with a declared 400 and never crash the daemon.
 */
import { type HttpMethod, WIRE_SCHEMAS, type WireSchemaName } from "@ddl/contract";
import { arb, invalidFor, wireArbitraries } from "@ddl/contract/testing";
import type { ApiRouteName, Thread } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { beforeAll, describe, expect } from "vitest";
import { type ContractClient, contractClient, isSchemaRejection } from "./contract-test-helpers";
import { createTestApp, FakeAgentRuntime, makeApproval, makeThread } from "./test-helpers";

const numRuns = Math.max(10, Math.round((fc.readConfigureGlobal().numRuns ?? 100) / 4));
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

let api: ContractClient;
let runtime: FakeAgentRuntime;

beforeAll(async () => {
  runtime = new FakeAgentRuntime();
  api = contractClient(await createTestApp({ runtime }));
});

describe("runtime data comes back unchanged and conformant", () => {
  test.prop([arb.agentStatusResponse()], { numRuns })("GET agent/status", async (status) => {
    runtime.status = () => status;
    expect((await api.call("agentStatus", "GET")).body).toStrictEqual(json(status));
    expect((await api.call("connectors", "GET")).body).toStrictEqual(
      json({ connectors: status.connectors }),
    );
  });

  test.prop([arb.notePath(), arb.taskRecordsResponse()], { numRuns })(
    "GET tasks",
    async (notePath, { records }) => {
      runtime.records.set(notePath, records);
      const { body } = await api.call("tasks", "GET", { query: { notePath } });
      expect(body).toStrictEqual(json({ records }));
    },
  );

  test.prop([arb.threadResponse()], { numRuns })("GET threads/:id", async (response) => {
    runtime.getThread = (id) => (id === response.thread.id ? response : undefined);
    const { body } = await api.call("thread", "GET", { params: { id: response.thread.id } });
    expect(body).toStrictEqual(json(response));
  });

  test.prop([fc.uniqueArray(arb.thread(), { selector: (t) => t.id, maxLength: 5 })], { numRuns })(
    "GET threads",
    async (threads: Thread[]) => {
      runtime.threads.clear();
      for (const thread of threads) runtime.threads.set(thread.id, thread);
      const { body } = await api.call("threads", "GET");
      expect((body as { threads: Array<{ id: string }> }).threads.map((t) => t.id)).toEqual(
        threads.map((t) => t.id),
      );
    },
  );

  test.prop([fc.uniqueArray(arb.approvalRequest(), { selector: (a) => a.id, maxLength: 5 })], {
    numRuns,
  })("GET approvals and approvals/:id", async (approvals) => {
    runtime.approvals = approvals;
    expect((await api.call("approvals", "GET")).body).toStrictEqual(json({ approvals }));
    for (const approval of approvals) {
      const { body } = await api.call("approval", "GET", { params: { id: approval.id } });
      expect(body).toStrictEqual(json({ approval }));
    }
  });
});

describe("vault data comes back unchanged and conformant", () => {
  const notes = fc.uniqueArray(fc.record({ path: arb.notePath(), content: arb.text(2_000) }), {
    selector: (note) => note.path.toLowerCase(),
    minLength: 1,
    maxLength: 4,
  });

  test.prop([notes, arb.text(40)], { numRuns })("tree, notes and search", async (files, query) => {
    const app = await createTestApp();
    const client = contractClient(app);
    for (const file of files) await app.storage.write(file.path, file.content);
    const { body: tree } = await client.call("tree", "GET");
    const listed = (tree as { entries: Array<{ path: string }> }).entries.map((e) => e.path);
    for (const file of files) {
      expect(listed).toContain(file.path);
      const { body } = await client.call("note", "GET", { params: { path: file.path } });
      expect(body).toMatchObject({ path: file.path, content: file.content });
    }
    await client.call("search", "GET", { query: { q: query } });
  });
});

interface BodyCase {
  name: ApiRouteName;
  method: HttpMethod;
  schema: WireSchemaName;
  params?: Record<string, string>;
}

const BODY_CASES: BodyCase[] = [
  { name: "note", method: "PUT", schema: "WriteNoteRequest", params: { path: "Notes/Fuzz.md" } },
  { name: "rename", method: "POST", schema: "RenameRequest" },
  { name: "folders", method: "POST", schema: "CreateFolderRequest" },
  { name: "settings", method: "PUT", schema: "UpdateSettingsRequest" },
  { name: "settings", method: "PATCH", schema: "UpdateSettingsRequest" },
  { name: "agentEnabled", method: "PUT", schema: "SetAgentEnabledRequest" },
  { name: "agentEnabled", method: "POST", schema: "SetAgentEnabledRequest" },
  { name: "threadMessages", method: "POST", schema: "PostMessageRequest", params: { id: "thr_1" } },
  { name: "approval", method: "POST", schema: "ApprovalDecisionRequest", params: { id: "apr_1" } },
];

describe.each(BODY_CASES)("$method $name body", ({ name, method, schema, params }) => {
  let client: ContractClient;

  beforeAll(async () => {
    const fake = new FakeAgentRuntime();
    fake.threads.set("thr_1", makeThread("thr_1"));
    const app = await createTestApp({ runtime: fake });
    await app.storage.write("Notes/Fuzz.md", "- [ ] seed");
    client = contractClient(app);
    // Every decision finds the approval still pending.
    fake.approvals = [makeApproval("apr_1")];
    fake.decideApproval = async (id, decision) => ({
      ...makeApproval(id),
      status: decision.decision === "approve" ? "approved" : "denied",
      decidedAt: 2,
    });
  });

  test.prop([wireArbitraries[schema]()], { numRuns })(
    "valid bodies pass validation (any other outcome is a declared one)",
    async (body) => {
      const { status, body: answer } = await client.call(name, method, { params, json: body });
      expect(status).not.toBe(500);
      expect(isSchemaRejection(answer), JSON.stringify(answer)).toBe(false);
    },
  );

  test.prop([invalidFor(WIRE_SCHEMAS[schema], wireArbitraries[schema]())], { numRuns })(
    "invalid bodies are rejected with 400 invalid_request",
    async (body) => {
      const { status, body: answer } = await client.call(name, method, { params, json: body });
      expect(status).toBe(400);
      expect(answer).toMatchObject({ error: "invalid_request" });
      expect(isSchemaRejection(answer)).toBe(true);
    },
  );

  test.prop([fc.string({ unit: "binary", maxLength: 200 })], { numRuns })(
    "arbitrary text bodies never crash the daemon",
    async (raw) => {
      const { status } = await client.call(name, method, {
        params,
        body: raw,
        headers: { "content-type": "application/json" },
      });
      expect([200, 201, 400, 404, 409]).toContain(status);
    },
  );
});

describe("queries and paths never crash the daemon", () => {
  const value = fc.oneof(
    arb.text(600),
    fc.constantFrom("", "0", "-1", "1e3", "%", "true", "..", ".hidden/x.md"),
  );

  test.prop([value, value], { numRuns })("search", async (q, limit) => {
    expect((await api.call("search", "GET", { query: { q, limit } })).status).not.toBe(500);
  });

  test.prop([value, value, value], { numRuns })("filters", async (notePath, taskId, status) => {
    runtime.records.clear();
    runtime.threads.clear();
    runtime.approvals = [];
    for (const [route, query] of [
      ["tasks", { notePath }],
      ["threads", { notePath, taskId }],
      ["approvals", { status }],
    ] as const) {
      expect((await api.call(route, "GET", { query })).status).not.toBe(500);
    }
  });

  /** URL parsers remove `.`/`..` segments (even `%2e`) before a request leaves the client. */
  const hasDotSegment = (path: string) => path.split("/").some((s) => /^(\.|%2e){1,2}$/i.test(s));
  const notePaths = fc
    .oneof(
      arb.requestPath(),
      arb.text(300),
      fc.constantFrom("a\\..\\..\\b.md", "%2e%2e/x.md", "a%00.md"),
    )
    .filter((path) => !hasDotSegment(path));

  test.prop([notePaths], { numRuns })("note paths", async (path) => {
    for (const method of ["GET", "DELETE"] as const) {
      expect((await api.call("note", method, { params: { path } })).status).not.toBe(500);
    }
    const put = await api.call("note", "PUT", { params: { path }, json: { content: "x" } });
    expect(put.status).not.toBe(500);
  });

  test.prop([fc.oneof(arb.isoDate(), arb.text(20)), fc.constantFrom("1", "0", "yes", "")], {
    numRuns,
  })("daily dates", async (date, create) => {
    const { status } = await api.call("daily", "GET", { params: { date }, query: { create } });
    expect(status).not.toBe(500);
  });

  test.prop([fc.oneof(arb.runtimeId(), arb.text(250))], { numRuns })("ids", async (id) => {
    for (const route of ["thread", "approval"] as const) {
      expect((await api.call(route, "GET", { params: { id } })).status).not.toBe(500);
    }
    const artifact = await api.call("artifact", "GET", {
      params: { threadId: id, artifactId: id },
    });
    expect(artifact.status).not.toBe(500);
  });
});

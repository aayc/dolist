/**
 * HttpDaemonClient ⇄ contract: a fake daemon (`fetch`) routes every request with the contract,
 * validates its parameters, query and body strictly, and answers with arbitrary valid responses
 * or declared errors. Every client method must send conformant requests, parse every valid
 * answer, and map every error status to the right client error.
 */

import { arb, wireArbitraries } from "@ddl/contract/testing";
import {
  API_CONTRACT,
  COMMON_API_ERRORS,
  exact,
  type HttpMethod,
  matchRoute,
  type OperationSpec,
  type ResponseSpec,
  type RouteSpec,
  type WireSchemaName,
  wireRegistry,
} from "@ddl/contract/wire";
import type { ApiRouteName } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "./client";
import { ConflictError, HttpError, NetworkError } from "./errors";
import { HttpDaemonClient } from "./http-client";

const TOKEN = "t0ken";
const numRuns = Math.max(10, Math.round((fc.readConfigureGlobal().numRuns ?? 100) / 4));

interface Sent {
  name: ApiRouteName;
  method: HttpMethod;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status: number; body?: unknown; bytes?: Uint8Array; contentType?: string };

/** A daemon that checks each request against the contract before `reply` answers it. */
function contractDaemon(reply: (sent: Sent) => Reply) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const match = matchRoute(url.pathname);
    expect(match, `unknown route ${url.pathname}`).not.toBeNull();
    const method = (init.method ?? "GET") as HttpMethod;
    const route: RouteSpec = API_CONTRACT[match!.name];
    const op: OperationSpec | undefined = route.methods[method];
    expect(op, `${method} ${route.path} is not in the contract`).toBeDefined();
    const params = route.params?.safeParse(match!.params);
    expect(params?.error?.issues ?? []).toEqual([]);
    const query = Object.fromEntries(url.searchParams);
    if (op?.query) expect(op.query.safeParse(query).error?.issues ?? []).toEqual([]);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (op?.body) expect(exact(op.body).safeParse(body).error?.issues ?? []).toEqual([]);
    else expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const request: Sent = {
      name: match!.name,
      method,
      params: match!.params,
      query,
      body,
      headers,
    };
    sent.push(request);
    const answer = reply(request);
    if (answer.bytes) {
      return new Response(answer.bytes as Uint8Array<ArrayBuffer>, {
        status: answer.status,
        headers: { "content-type": answer.contentType ?? "application/octet-stream" },
      });
    }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpDaemonClient({
    baseUrl: "http://127.0.0.1:7331",
    token: TOKEN,
    fetch: fetchImpl,
  });
  return { client, sent };
}

function responses(name: ApiRouteName, method: HttpMethod): Record<number, ResponseSpec> {
  return (
    API_CONTRACT[name].methods as Record<string, { responses: Record<number, ResponseSpec> }>
  )[method]!.responses;
}

/** An arbitrary valid body for a response spec. */
function bodyFor(spec: ResponseSpec): fc.Arbitrary<unknown> {
  if (spec.kind === "binary") return fc.constant(undefined);
  const id = wireRegistry.get(spec.schema)?.id as WireSchemaName | undefined;
  if (id) return wireArbitraries[id]() as fc.Arbitrary<unknown>;
  // Anonymous union (rename 409): any member.
  return fc.oneof(wireArbitraries.ConflictResponse(), wireArbitraries.ApiErrorBody());
}

interface Case<I> {
  name: ApiRouteName;
  method: HttpMethod;
  input: fc.Arbitrary<I>;
  invoke: (client: DaemonClient, input: I) => Promise<unknown>;
  /** The request the client must send, as the daemon parses it. */
  expectSent?: (input: I, sent: Sent) => void;
  /** What the method returns for a successful response body. */
  result: (body: unknown) => unknown;
}

const self = (body: unknown) => body;
const nothing = () => undefined;

function withCase<I>(c: Case<I>): Case<unknown> {
  return c as Case<unknown>;
}

const CASES: Array<Case<unknown>> = [
  withCase({
    name: "health",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.health(),
    result: self,
  }),
  withCase({
    name: "tree",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.getTree(),
    result: self,
  }),
  withCase({
    name: "note",
    method: "GET",
    input: arb.notePath(),
    invoke: (c, path) => c.readNote(path),
    expectSent: (path, sent) => expect(sent.params.path).toBe(path),
    result: self,
  }),
  withCase({
    name: "note",
    method: "PUT",
    input: fc.tuple(arb.notePath(), arb.writeNoteRequest(), fc.boolean()),
    invoke: (c, [path, body, keepalive]) => c.writeNote(path, body, { keepalive }),
    expectSent: ([path, body], sent) => {
      expect(sent.params.path).toBe(path);
      expect(sent.body).toStrictEqual(body);
    },
    result: self,
  }),
  withCase({
    name: "note",
    method: "DELETE",
    input: arb.notePath(),
    invoke: (c, path) => c.deleteNote(path),
    expectSent: (path, sent) => expect(sent.params.path).toBe(path),
    result: nothing,
  }),
  withCase({
    name: "rename",
    method: "POST",
    input: arb.renameRequest(),
    invoke: (c, { from, to }) => c.renamePath(from, to),
    expectSent: (body, sent) => expect(sent.body).toStrictEqual(body),
    result: nothing,
  }),
  withCase({
    name: "folders",
    method: "POST",
    input: arb.folderPath(),
    invoke: (c, path) => c.createFolder(path),
    expectSent: (path, sent) => expect(sent.body).toStrictEqual({ path }),
    result: nothing,
  }),
  withCase({
    name: "folders",
    method: "DELETE",
    input: arb.folderPath(),
    invoke: (c, path) => c.deleteFolder(path),
    expectSent: (path, sent) => expect(sent.query).toEqual({ path }),
    result: nothing,
  }),
  withCase({
    name: "daily",
    method: "GET",
    input: fc.tuple(arb.isoDate(), fc.boolean()),
    invoke: (c, [date, create]) => c.getDailyNote(date, create),
    expectSent: ([date, create], sent) => {
      expect(sent.params.date).toBe(date);
      expect(sent.query).toEqual(create ? { create: "1" } : {});
    },
    result: self,
  }),
  withCase({
    name: "search",
    method: "GET",
    input: arb.text(500),
    invoke: (c, q) => c.search(q),
    expectSent: (q, sent) => expect(sent.query).toEqual({ q }),
    result: self,
  }),
  withCase({
    name: "settings",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.getSettings(),
    result: self,
  }),
  withCase({
    name: "settings",
    method: "PUT",
    input: arb.updateSettingsRequest(),
    invoke: (c, patch) => c.updateSettings(patch),
    expectSent: (patch, sent) => expect(sent.body).toStrictEqual(patch),
    result: self,
  }),
  withCase({
    name: "agentStatus",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.getAgentStatus(),
    result: self,
  }),
  withCase({
    name: "agentEnabled",
    method: "POST",
    input: fc.boolean(),
    invoke: (c, enabled) => c.setAgentEnabled(enabled),
    expectSent: (enabled, sent) => expect(sent.body).toStrictEqual({ enabled }),
    result: self,
  }),
  withCase({
    name: "connectors",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.getConnectors(),
    result: (body) => (body as { connectors: unknown }).connectors,
  }),
  withCase({
    name: "tasks",
    method: "GET",
    input: arb.notePath(),
    invoke: (c, notePath) => c.getTaskRecords(notePath),
    expectSent: (notePath, sent) => expect(sent.query).toEqual({ notePath }),
    result: self,
  }),
  withCase({
    name: "threads",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.listThreads(),
    result: self,
  }),
  withCase({
    name: "thread",
    method: "GET",
    input: arb.runtimeId(),
    invoke: (c, id) => c.getThread(id),
    expectSent: (id, sent) => expect(sent.params.id).toBe(id),
    result: self,
  }),
  withCase({
    name: "threadMessages",
    method: "POST",
    input: fc.tuple(arb.runtimeId(), arb.trimmedText(20_000)),
    invoke: (c, [id, text]) => c.postMessage(id, text),
    expectSent: ([id, text], sent) => {
      expect(sent.params.id).toBe(id);
      expect(sent.body).toStrictEqual({ text });
    },
    result: nothing,
  }),
  withCase({
    name: "threadCancel",
    method: "POST",
    input: arb.runtimeId(),
    invoke: (c, id) => c.cancelThread(id),
    expectSent: (id, sent) => expect(sent.params.id).toBe(id),
    result: nothing,
  }),
  withCase({
    name: "threadRetry",
    method: "POST",
    input: arb.runtimeId(),
    invoke: (c, id) => c.retryThread(id),
    expectSent: (id, sent) => expect(sent.params.id).toBe(id),
    result: nothing,
  }),
  withCase({
    name: "approvals",
    method: "GET",
    input: fc.constant(null),
    invoke: (c) => c.listApprovals(),
    result: self,
  }),
  withCase({
    name: "approval",
    method: "POST",
    input: fc.tuple(arb.runtimeId("apr"), arb.approvalDecisionRequest()),
    invoke: (c, [id, decision]) => c.decideApproval(id, decision),
    expectSent: ([id, decision], sent) => {
      expect(sent.params.id).toBe(id);
      expect(sent.body).toStrictEqual(decision);
    },
    result: (body) => (body as { approval: unknown }).approval,
  }),
];

describe("HttpDaemonClient ⇄ contract", () => {
  it("covers every DaemonClient REST method", () => {
    const covered = new Set(CASES.map((c) => `${c.method} ${c.name}`));
    for (const key of ["GET artifact"]) covered.add(key);
    const client = new HttpDaemonClient({
      fetch: (async () => new Response()) as unknown as typeof fetch,
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter(
      (m) =>
        ![
          "constructor",
          "connect",
          "disconnect",
          "onEvent",
          "onConnectionChange",
          "send",
          "socketUrl",
          "connectionState",
        ].includes(m) &&
        !m.startsWith("handle") &&
        !m.endsWith("_") &&
        m !== "request",
    );
    expect(methods.length).toBe(CASES.length + 1);
  });

  describe.each(CASES.map((c) => [`${c.method} ${API_CONTRACT[c.name].path}`, c] as const))(
    "%s",
    (_label, c) => {
      const declared = responses(c.name, c.method);
      const success = Object.entries(declared).filter(([status]) => Number(status) < 300);
      const errors = [...Object.entries(declared), ...Object.entries(COMMON_API_ERRORS)].filter(
        ([status]) => Number(status) >= 400,
      );

      test.prop(
        [
          c.input,
          fc
            .constantFrom(...success)
            .chain(([status, spec]) =>
              bodyFor(spec).map((body) => ({ status: Number(status), body })),
            ),
        ],
        {
          numRuns,
        },
      )("sends a conformant request and returns the parsed answer", async (input, reply) => {
        const { client, sent } = contractDaemon(() => reply);
        const result = await c.invoke(client, input);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ name: c.name, method: c.method });
        c.expectSent?.(input, sent[0]!);
        expect(result).toStrictEqual(c.result(reply.body));
      });

      test.prop(
        [
          c.input,
          fc
            .constantFrom(...errors)
            .chain(([status, spec]) =>
              bodyFor(spec).map((body) => ({ status: Number(status), body, spec })),
            ),
        ],
        {
          numRuns,
        },
      )("maps every declared error to a client error", async (input, reply) => {
        const { client } = contractDaemon(() => ({ status: reply.status, body: reply.body }));
        const error = await c.invoke(client, input).then(
          () => expect.unreachable("the call should fail"),
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(reply.status);
        expect((error as HttpError).body).toStrictEqual(reply.body);
        const body = reply.body as { error: string; message?: string; current?: unknown };
        if (reply.status === 409 && "current" in body) {
          expect(error).toBeInstanceOf(ConflictError);
          expect((error as ConflictError).current).toStrictEqual(body.current);
        } else {
          expect(error).not.toBeInstanceOf(ConflictError);
          expect((error as HttpError).message).toBe(body.message || body.error);
        }
      });
    },
  );

  test.prop(
    [
      arb.runtimeId(),
      arb.runtimeId("art"),
      fc.uint8Array({ maxLength: 64 }),
      fc.constantFrom("text/markdown", "image/png", "application/octet-stream"),
    ],
    {
      numRuns,
    },
  )("GET artifact returns the bytes and their type", async (threadId, artifactId, bytes, mime) => {
    const { client, sent } = contractDaemon(() => ({
      status: 200,
      bytes,
      contentType: `${mime}; charset=utf-8`,
    }));
    const artifact = await client.getArtifact(threadId, artifactId);
    expect(sent[0]?.params).toEqual({ threadId, artifactId });
    expect(artifact.mimeType).toBe(mime);
    expect(new Uint8Array(await artifact.blob.arrayBuffer())).toEqual(bytes);
  });

  it("reports unreachable daemons as NetworkError", async () => {
    const client = new HttpDaemonClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toBeInstanceOf(NetworkError);
  });

  it("refuses note paths whose dot segments would change the route", async () => {
    const { client, sent } = contractDaemon(() => ({ status: 200, body: {} }));
    for (const path of ["../settings", "a/../../agent/enabled", "./x.md", "a/./b.md"]) {
      await expect(client.readNote(path), path).rejects.toMatchObject({ status: 400 });
      await expect(client.writeNote(path, { content: "x" }), path).rejects.toBeInstanceOf(
        HttpError,
      );
      await expect(client.deleteNote(path), path).rejects.toBeInstanceOf(HttpError);
    }
    expect(sent).toEqual([]);
  });
});

import { connect } from "node:net";
import { API_ROUTES } from "@ddl/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../app";
import { createTestApp, makeApproval, makeThread } from "../test-helpers";
import { httpRequest, type MemoryLiveApp, rawRequest, startLiveApp } from "./harness";

// Stretched on slow CI runners (TEST_TIME_SCALE, see scripts/vitest/setup-fast-check.ts).
const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

/** Every JSON endpoint with a body that it accepts. */
const JSON_ENDPOINTS: Array<{ method: string; path: string; valid: Record<string, unknown> }> = [
  { method: "PUT", path: API_ROUTES.note("a.md"), valid: { content: "x" } },
  { method: "POST", path: API_ROUTES.rename, valid: { from: "a.md", to: "b.md" } },
  { method: "POST", path: API_ROUTES.folders, valid: { path: "Folder" } },
  { method: "PUT", path: API_ROUTES.settings, valid: { theme: "dark" } },
  { method: "PATCH", path: API_ROUTES.settings, valid: { editor: { vimMode: true } } },
  { method: "PUT", path: API_ROUTES.agentEnabled, valid: { enabled: false } },
  { method: "POST", path: API_ROUTES.threadMessages("thr_1"), valid: { text: "hi" } },
  { method: "POST", path: API_ROUTES.approval("apr_1"), valid: { decision: "deny" } },
];

async function appWithFixtures() {
  const test = await createTestApp();
  const runtime = test.runtime as import("../test-helpers").FakeAgentRuntime;
  runtime.threads.set("thr_1", makeThread("thr_1"));
  runtime.approvals = [makeApproval("apr_1")];
  return test;
}

// The server drains an unread body for up to 500 ms before dropping the connection, so the tests
// that wait for that run concurrently (with the test context's `expect`).
describe.concurrent("request bodies over the limit", () => {
  let app: MemoryLiveApp;
  beforeAll(async () => {
    app = await startLiveApp();
  });
  afterAll(() => app.close());

  const put = (headers: Array<[string, string]>, body = "") =>
    httpRequest(
      "PUT",
      API_ROUTES.note("big.md"),
      [["Host", app.host], ["Content-Type", "application/json"], ...headers],
      body,
    );

  it("answers 413 from Content-Length alone, before any of the body is sent", async ({
    expect,
  }) => {
    const res = await rawRequest(
      app.port,
      put([
        ["Authorization", `Bearer ${app.token}`],
        ["Content-Length", String(MAX_BODY_BYTES + 1)],
      ]),
      { waitForClose: true, timeoutMs: 3_000 },
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: "payload_too_large" });
    // The unread body is drained briefly, then the connection is dropped.
    expect(res.closed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(2_000);
  });

  it("answers 401 to an unauthenticated oversized upload without reading it", async ({
    expect,
  }) => {
    const res = await rawRequest(app.port, put([["Content-Length", String(50 * MAX_BODY_BYTES)]]), {
      waitForClose: true,
      timeoutMs: 3_000,
    });
    expect(res.status).toBe(401);
    expect(res.closed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(2_000);
  });

  it("counts chunked bodies and stops at the limit", async ({ expect }) => {
    const socket = connect(app.port, "127.0.0.1");
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("error", () => {});
    socket.write(
      put([
        ["Authorization", `Bearer ${app.token}`],
        ["Transfer-Encoding", "chunked"],
      ]),
    );
    const chunk = Buffer.alloc(512 * 1024, 0x20);
    let sent = 0;
    while (!socket.destroyed && !response && sent < 4 * MAX_BODY_BYTES) {
      const ok = socket.write(`${chunk.length.toString(16)}\r\n`) && socket.write(chunk);
      socket.write("\r\n");
      sent += chunk.length;
      if (!ok) {
        await new Promise((resolve) => {
          socket.once("drain", resolve);
          socket.once("close", resolve);
        });
      }
    }
    await closed;
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(sent).toBeLessThan(4 * MAX_BODY_BYTES);
  });

  it("accepts a body of exactly the limit and rejects one byte more", async ({ expect }) => {
    const { request } = await createTestApp();
    const overhead = JSON.stringify({ content: "" }).length;
    const exact = JSON.stringify({ content: "x".repeat(MAX_BODY_BYTES - overhead) });
    expect(exact).toHaveLength(MAX_BODY_BYTES);
    const ok = await request(API_ROUTES.note("exact.md"), { method: "PUT", body: exact });
    expect(ok.status).toBe(201);
    const over = await request(API_ROUTES.note("over.md"), { method: "PUT", body: `${exact} ` });
    expect(over.status).toBe(413);
  });

  it("refuses Content-Length together with Transfer-Encoding (request smuggling)", async ({
    expect,
  }) => {
    const res = await rawRequest(
      app.port,
      put(
        [
          ["Authorization", `Bearer ${app.token}`],
          ["Content-Length", "4"],
          ["Transfer-Encoding", "chunked"],
          ["Connection", "close"],
        ],
        '0\r\n\r\n{"content":"smuggled"}',
      ),
    );
    expect(res.status).toBe(400);
    expect(await app.storage.read("big.md")).toBeNull();
  });

  it("answers 431 to oversized headers", async ({ expect }) => {
    const res = await rawRequest(
      app.port,
      httpRequest("GET", `${API_ROUTES.search("x")}${"y".repeat(20_000)}`, [
        ["Host", app.host],
        ["Authorization", `Bearer ${app.token}`],
        ["Connection", "close"],
      ]),
    );
    expect(res.status).toBe(431);
  });
});

describe.concurrent("slow and partial requests", () => {
  let app: MemoryLiveApp;
  beforeAll(async () => {
    app = await startLiveApp();
  });
  afterAll(() => app.close());

  it("cuts off an unauthenticated partial body right after answering", async ({ expect }) => {
    const res = await rawRequest(
      app.port,
      httpRequest(
        "PUT",
        API_ROUTES.note("slow.md"),
        [
          ["Host", app.host],
          ["Content-Type", "application/json"],
          ["Content-Length", "1000"],
        ],
        '{"content":"sl',
      ),
      { waitForClose: true, timeoutMs: 3_000 },
    );
    expect(res.status).toBe(401);
    expect(res.closed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(1_500);
  });

  it("keeps serving other clients while an authenticated body trickles in, then completes it", async ({
    expect,
  }) => {
    const body = JSON.stringify({ content: "finally" });
    const socket = connect(app.port, "127.0.0.1");
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    socket.write(
      httpRequest(
        "PUT",
        API_ROUTES.note("slow.md"),
        [
          ["Host", app.host],
          ["Authorization", `Bearer ${app.token}`],
          ["Content-Type", "application/json"],
          ["Content-Length", String(Buffer.byteLength(body))],
          ["Connection", "close"],
        ],
        body.slice(0, 5),
      ),
    );
    const slowHeaders = connect(app.port, "127.0.0.1");
    slowHeaders.write(`GET ${API_ROUTES.health} HTTP/1.1\r\nHost: ${app.host}\r\n`);

    const others = await Promise.all(
      Array.from({ length: 10 }, () => app.api(API_ROUTES.health).then((r) => r.status)),
    );
    expect(others).toEqual(Array(10).fill(200));
    expect(response).toBe("");

    const done = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.end(body.slice(5));
    await done;
    expect(response).toMatch(/^HTTP\/1\.1 201 /);
    expect((await app.storage.read("slow.md"))?.content).toBe("finally");
    slowHeaders.destroy();
  });
});

describe("content types and malformed JSON", () => {
  it("parses the body as JSON whatever the Content-Type (the token and Origin stop CSRF)", async () => {
    const { request } = await createTestApp();
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "",
    ]) {
      const res = await request(API_ROUTES.note("typed.md"), {
        method: "PUT",
        headers: type ? { "content-type": type } : {},
        body: JSON.stringify({ content: type }),
      });
      expect(res.ok, type).toBe(true);
    }
    const form = await request(API_ROUTES.note("typed.md"), {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "content=x",
    });
    expect(form.status).toBe(400);
    expect(await form.json()).toMatchObject({ error: "invalid_json" });
  });

  it("answers invalid_json to a corpus of malformed bodies, on every JSON endpoint", async () => {
    const { request } = await appWithFixtures();
    const corpus = [
      "",
      " ",
      "{",
      "}",
      "nul",
      "{'content':'x'}",
      '{"content":"x",}',
      '{"content":"x"} {"content":"y"}',
      '{"content":"x"}]',
      "[1,]",
      "NaN",
      "Infinity",
      "undefined",
      '{"content":"\u0000',
      '{"content":"x"\u0000}',
      '{"content":01}',
      '{"content":"\\x41"}',
      "\u0000",
      "\uFFFF",
    ];
    for (const { method, path } of JSON_ENDPOINTS) {
      for (const body of corpus) {
        const res = await request(path, {
          method,
          body,
          headers: { "content-type": "application/json" },
        });
        expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_json" });
      }
    }
  });

  it("answers invalid_request to well-formed JSON of the wrong shape", async () => {
    const { request } = await appWithFixtures();
    for (const { method, path, valid } of JSON_ENDPOINTS) {
      // An empty settings patch is a valid no-op.
      const empty = path === API_ROUTES.settings ? [] : [{}];
      for (const json of [null, true, 0, "x", [], [valid], { ...valid, extra: 1 }, ...empty]) {
        const res = await request(path, { method, json });
        expect(res.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_request" });
      }
    }
  });

  it("tolerates a UTF-8 byte order mark before the JSON", async () => {
    const { request } = await createTestApp();
    const res = await request(API_ROUTES.note("bom.md"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: `\uFEFF${JSON.stringify({ content: "x" })}`,
    });
    expect(res.status).toBe(201);
  });

  it("rejects deeply nested and very wide JSON quickly, without crashing", async () => {
    const { request } = await appWithFixtures();
    const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
    const deepObject = `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`;
    const wide = JSON.stringify(
      Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i])),
    );
    const started = performance.now();
    for (const { method, path } of JSON_ENDPOINTS) {
      for (const body of [deep, deepObject, wide]) {
        const res = await request(path, {
          method,
          body,
          headers: { "content-type": "application/json" },
        });
        expect([400], `${method} ${path}`).toContain(res.status);
      }
    }
    expect(performance.now() - started).toBeLessThan(1_500 * TIME_SCALE);
    expect((await request(API_ROUTES.health)).status).toBe(200);
  });
});

describe("prototype pollution", () => {
  const payloads = [
    '{"__proto__":{"polluted":"yes"}}',
    '{"constructor":{"prototype":{"polluted":"yes"}}}',
    '{"prototype":{"polluted":"yes"}}',
  ];

  it("never pollutes Object.prototype through any JSON endpoint or the settings merge", async () => {
    const { request, settings } = await appWithFixtures();
    const before = JSON.stringify(settings.get());
    for (const { method, path, valid } of JSON_ENDPOINTS) {
      const bodies = [
        ...payloads,
        ...payloads.map((p) => `${JSON.stringify(valid).slice(0, -1)},${p.slice(1)}`),
      ];
      if (path === API_ROUTES.settings) {
        for (const section of ["editor", "agent", "dailyNotes"]) {
          bodies.push(...payloads.map((p) => `{"${section}":${p}}`));
          bodies.push(`{"agent":{"watch":${payloads[0]}}}`);
        }
      }
      for (const body of bodies) {
        const res = await request(path, {
          method,
          body,
          headers: { "content-type": "application/json" },
        });
        expect(res.status, `${method} ${path} ${body}`).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_request" });
      }
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(JSON.stringify(settings.get())).toBe(before);
  });
});

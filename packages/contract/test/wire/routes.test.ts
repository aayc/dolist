import { API_ROUTES, type ApiRouteName } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { arb } from "../../src/testing";
import {
  API_CONTRACT,
  API_ERROR_CODES,
  COMMON_API_ERRORS,
  listOperations,
  matchRoute,
  REQUEST_SCHEMA_NAMES,
  type RouteAuth,
  WIRE_SCHEMAS,
  wireRegistry,
} from "../../src/wire";

const routeNames = Object.keys(API_ROUTES) as ApiRouteName[];
const requestSchemas = new Set<z.ZodType>(REQUEST_SCHEMA_NAMES.map((name) => WIRE_SCHEMAS[name]));

function pathnameOf(url: string): string {
  return new URL(url, "http://127.0.0.1:7331").pathname;
}

describe("API_CONTRACT coverage", () => {
  it("has exactly one entry per API_ROUTES route", () => {
    expect(Object.keys(API_CONTRACT).sort()).toEqual([...routeNames].sort());
  });

  it("matches every static route to itself", () => {
    for (const name of routeNames) {
      const route = API_ROUTES[name];
      if (typeof route !== "string") continue;
      expect(matchRoute(route)?.name, name).toBe(name);
      expect(API_CONTRACT[name].path).toBe(route);
    }
  });

  it("returns null for unknown paths", () => {
    for (const path of ["/", "/api", "/api/nope", "/api/threads", "/api/threads/a/b/c", "/wsx"]) {
      expect(matchRoute(path)?.name ?? null, path).toBe(path === "/api/threads" ? "threads" : null);
    }
    expect(matchRoute("/api/threads/%E0%A4%A")).toBeNull();
  });

  test.prop([arb.notePath()])("note(path) round-trips through the pattern", (path) => {
    const match = matchRoute(pathnameOf(API_ROUTES.note(path)));
    expect(match).toMatchObject({ name: "note", params: { path } });
  });

  test.prop([arb.runtimeId()])("id routes round-trip through their patterns", (id) => {
    const cases: Array<[ApiRouteName, string]> = [
      ["thread", API_ROUTES.thread(id)],
      ["threadMessages", API_ROUTES.threadMessages(id)],
      ["threadCancel", API_ROUTES.threadCancel(id)],
      ["threadRetry", API_ROUTES.threadRetry(id)],
      ["approval", API_ROUTES.approval(id)],
      ["pairedDevice", API_ROUTES.pairedDevice(id)],
    ];
    for (const [name, url] of cases) {
      expect(matchRoute(pathnameOf(url)), name).toMatchObject({ name, params: { id } });
    }
    expect(matchRoute(pathnameOf(API_ROUTES.artifact(id, `${id}x`)))).toMatchObject({
      name: "artifact",
      params: { threadId: id, artifactId: `${id}x` },
    });
  });

  test.prop([arb.isoDate(), fc.boolean()])("daily(date) round-trips", (date, create) => {
    const url = new URL(API_ROUTES.daily(date, create), "http://127.0.0.1:7331");
    expect(matchRoute(url.pathname)).toMatchObject({ name: "daily", params: { date } });
    expect(url.searchParams.get("create")).toBe(create ? "1" : null);
    const params = API_CONTRACT.daily.params.safeParse({ date });
    expect(params.success).toBe(true);
  });

  test.prop([arb.text(500), arb.notePath()])(
    "query builders encode their values",
    (q, notePath) => {
      const search = new URL(API_ROUTES.search(q), "http://127.0.0.1:7331");
      expect(matchRoute(search.pathname)?.name).toBe("search");
      expect(search.searchParams.get("q")).toBe(q);
      const tasks = new URL(API_ROUTES.tasks(notePath), "http://127.0.0.1:7331");
      expect(matchRoute(tasks.pathname)?.name).toBe("tasks");
      expect(tasks.searchParams.get("notePath")).toBe(notePath);
    },
  );
});

describe("operations", () => {
  const operations = listOperations();

  it("lists every method of every route", () => {
    const count = Object.values(API_CONTRACT).reduce(
      (sum, route) => sum + Object.keys(route.methods).length,
      0,
    );
    expect(operations).toHaveLength(count);
  });

  it.each(operations.map((op) => [`${op.method} ${op.route.path}`, op] as const))(
    "%s is well-formed",
    (_label, { name, route, operation }) => {
      const statuses = Object.keys(operation.responses).map(Number);
      if (name !== "ws")
        expect(statuses.some((status) => status >= 200 && status < 300)).toBe(true);
      for (const [status, response] of Object.entries(operation.responses)) {
        const code = Number(status);
        if (response.kind === "error") {
          expect(code, `${status} is an error status`).toBeGreaterThanOrEqual(400);
          expect(response.codes.length).toBeGreaterThan(0);
          for (const errorCode of response.codes) expect(API_ERROR_CODES).toContain(errorCode);
        } else {
          expect(code, `${status} is a success status`).toBeLessThan(300);
        }
        if (response.kind === "empty") expect(code).toBe(204);
        if (response.kind === "json") {
          expect(wireRegistry.has(response.schema), "response schemas are named").toBe(true);
          expect(requestSchemas.has(response.schema), "responses use tolerant schemas").toBe(false);
        }
      }
      if (operation.body) {
        expect(requestSchemas.has(operation.body), "bodies use strict request schemas").toBe(true);
        expect(operation.responses).toHaveProperty("413");
        expect(operation.responses).toHaveProperty("400");
      }
      const patternParams = [...route.path.matchAll(/:(\w+)|\*/g)].map((m) => m[1] ?? "path");
      expect(Object.keys(route.params?.shape ?? {}).sort()).toEqual(patternParams.sort());
    },
  );

  it("declares the common errors once, for every /api route", () => {
    expect(Object.keys(COMMON_API_ERRORS)).toEqual(["401", "403", "500"]);
    const byAuth = (auth: RouteAuth) =>
      Object.entries(API_CONTRACT)
        .filter(([, route]) => route.auth === auth)
        .map(([name]) => name)
        .sort();
    expect(byAuth("upgrade")).toEqual(["ws"]);
    expect(byAuth("pairing_code")).toEqual(["pair"]);
    expect(byAuth("bearer")).toEqual(routeNames.filter((n) => n !== "ws" && n !== "pair").sort());
    for (const [name, route] of Object.entries(API_CONTRACT)) {
      expect(route.path.startsWith("/api/"), name).toBe(route.auth !== "upgrade");
    }
  });

  it("keeps `unauthorized` in the 401 of every bearer route that declares its own", () => {
    for (const { name, route, operation } of operations) {
      const own = operation.responses[401];
      if (!own || route.auth !== "bearer") continue;
      expect(own.kind === "error" && own.codes, name).toContain("unauthorized");
    }
    expect(API_CONTRACT.pair.methods.POST.responses[401].codes).toEqual(["pairing_rejected"]);
  });

  it("uses each error code only with its documented status", () => {
    const statusesByCode = new Map<string, Set<number>>();
    for (const { operation } of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response.kind !== "error") continue;
        for (const code of response.codes) {
          const set = statusesByCode.get(code) ?? new Set();
          set.add(Number(status));
          statusesByCode.set(code, set);
        }
      }
    }
    expect(
      Object.fromEntries([...statusesByCode].map(([code, set]) => [code, [...set].sort()])),
    ).toMatchInlineSnapshot(`
      {
        "agent_error": [
          500,
        ],
        "agent_unavailable": [
          503,
        ],
        "conflict": [
          409,
        ],
        "forbidden_host": [
          403,
        ],
        "internal_error": [
          500,
        ],
        "invalid_json": [
          400,
        ],
        "invalid_path": [
          400,
        ],
        "invalid_request": [
          400,
        ],
        "invalid_settings": [
          400,
        ],
        "locked_by_env": [
          409,
        ],
        "machine_unreachable": [
          502,
        ],
        "not_found": [
          404,
        ],
        "pairing_rejected": [
          401,
        ],
        "payload_too_large": [
          413,
        ],
        "rate_limited": [
          429,
        ],
        "unauthorized": [
          401,
        ],
        "upgrade_required": [
          426,
        ],
      }
    `);
  });
});

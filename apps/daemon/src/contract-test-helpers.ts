/**
 * Helpers for the daemon's contract conformance tests: call any route of `API_CONTRACT` and check
 * the answer against the schema declared for its status (strictly, via `exact`).
 */
import {
  API_CONTRACT,
  COMMON_API_ERRORS,
  exact,
  type HttpMethod,
  type ResponseSpec,
} from "@ddl/contract";
import { type ApiRouteName, encodeVaultPath } from "@ddl/core";
import { expect } from "vitest";
import type { TestApp, TestRequestInit } from "./test-helpers";

export interface CallInit extends Omit<TestRequestInit, "method"> {
  params?: Record<string, string>;
  query?: Record<string, string>;
}

export interface CallResult {
  status: number;
  body: unknown;
  response: Response;
}

/** Statuses observed per operation (`GET note`), for reachability checks. */
export type Observed = Map<string, Set<number>>;

export function operationKey(name: ApiRouteName, method: HttpMethod): string {
  return `${method} ${name}`;
}

/** The URL path of a route with its parameters filled in (the vault path wildcard keeps `/`). */
export function routePath(name: ApiRouteName, params: Record<string, string> = {}): string {
  return API_CONTRACT[name].path
    .split("/")
    .map((segment) => {
      if (segment === "*") return encodeVaultPath(params.path ?? "");
      if (segment.startsWith(":")) return encodeURIComponent(params[segment.slice(1)] ?? "");
      return segment;
    })
    .join("/");
}

/** The response spec the contract declares for this operation and status, if any. */
export function declaredResponse(
  name: ApiRouteName,
  method: HttpMethod,
  status: number,
): ResponseSpec | undefined {
  const operation = (
    API_CONTRACT[name].methods as Partial<
      Record<HttpMethod, { responses: Record<number, ResponseSpec> }>
    >
  )[method];
  const common =
    API_CONTRACT[name].auth === "upgrade"
      ? undefined
      : (COMMON_API_ERRORS as Record<number, ResponseSpec>)[status];
  return operation?.responses[status] ?? common;
}

/** Asserts that `status`/`body` is what the contract declares for this operation. */
export function expectConforms(
  name: ApiRouteName,
  method: HttpMethod,
  status: number,
  body: unknown,
): void {
  const label = `${method} ${API_CONTRACT[name].path} → ${status}`;
  const spec = declaredResponse(name, method, status);
  expect(spec, `${label} is not a declared status`).toBeDefined();
  if (spec?.kind === "empty") expect(body, `${label} has no body`).toBeUndefined();
  if (!spec || spec.kind === "binary" || spec.kind === "empty") return;
  const parsed = exact(spec.schema).safeParse(body);
  expect(parsed.error?.issues ?? [], `${label} body: ${JSON.stringify(body)}`).toEqual([]);
  if (spec.kind === "error") {
    expect(spec.codes, `${label} error code`).toContain((body as { error: string }).error);
  }
}

/** A client for one test app that validates every answer and records observed statuses. */
export function contractClient(app: TestApp, observed: Observed = new Map()) {
  return {
    observed,
    async call(name: ApiRouteName, method: HttpMethod, init: CallInit = {}): Promise<CallResult> {
      const { params, query, ...request } = init;
      const search = query ? `?${new URLSearchParams(query).toString()}` : "";
      const response = await app.request(`${routePath(name, params)}${search}`, {
        ...request,
        method,
      });
      const spec = declaredResponse(name, method, response.status);
      const body =
        spec?.kind === "binary"
          ? await response.arrayBuffer()
          : await response.json().catch(() => undefined);
      expectConforms(name, method, response.status, body);
      const key = operationKey(name, method);
      observed.set(key, (observed.get(key) ?? new Set()).add(response.status));
      return { status: response.status, body, response };
    },
  };
}

export type ContractClient = ReturnType<typeof contractClient>;

/** zod's prettified validation errors (what schema rejections carry as `message`). */
export function isSchemaRejection(body: unknown): boolean {
  const message = (body as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message.startsWith("✖");
}

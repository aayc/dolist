/**
 * The agent routes the relay forwards to the always-on machine, and nothing else. Paths, query
 * parameters and body schemas come from the contract, so the allowlist can't drift from the API.
 */
import {
  API_CONTRACT,
  type OperationSpec,
  type RouteSpec,
  RUNTIME_ID_PATTERN,
} from "@ddl/contract";
import type { ApiRouteName } from "@ddl/core";
import type { z } from "zod";

/**
 * What happens to a relayed request the machine can't answer:
 * - `read`: served by this device's read-only view of the synced sidecar;
 * - `action`: needs the agent, answered 503 `agent_unavailable`;
 * - `file`: edits a routine file, done on this device (it syncs).
 */
export type RelayRouteKind = "read" | "action" | "file";

export type RelayMethod = "GET" | "POST";

interface RelayRule {
  name: ApiRouteName;
  method: RelayMethod;
  kind: RelayRouteKind;
}

export const RELAY_RULES = [
  { name: "agentStatus", method: "GET", kind: "read" },
  { name: "tasks", method: "GET", kind: "read" },
  { name: "threads", method: "GET", kind: "read" },
  { name: "thread", method: "GET", kind: "read" },
  { name: "threadMessages", method: "POST", kind: "action" },
  { name: "threadCancel", method: "POST", kind: "action" },
  { name: "threadRetry", method: "POST", kind: "action" },
  { name: "approvals", method: "GET", kind: "read" },
  { name: "approval", method: "GET", kind: "read" },
  { name: "approval", method: "POST", kind: "action" },
  { name: "artifact", method: "GET", kind: "read" },
  { name: "routines", method: "GET", kind: "read" },
  { name: "routines", method: "POST", kind: "file" },
  { name: "routine", method: "GET", kind: "read" },
  { name: "routineRun", method: "POST", kind: "action" },
  { name: "routinePause", method: "POST", kind: "file" },
  { name: "routineResume", method: "POST", kind: "file" },
] as const satisfies readonly RelayRule[];

export interface RelayRoute {
  name: ApiRouteName;
  method: RelayMethod;
  kind: RelayRouteKind;
  /**
   * Path and query sent to the machine, rebuilt from the contract's path, the validated ids and
   * the query parameters the operation declares (first value of each).
   */
  target: string;
  /** The operation's JSON body schema, when it takes one. */
  body: z.ZodType | undefined;
  /** The answer is bytes (an artifact), not JSON. */
  binary: boolean;
}

interface CompiledRule extends RelayRule {
  segments: string[];
  operation: OperationSpec;
  queryKeys: string[];
  binary: boolean;
}

const COMPILED: CompiledRule[] = RELAY_RULES.map((rule) => {
  const route = API_CONTRACT[rule.name] as RouteSpec;
  const operation = route.methods[rule.method];
  if (!operation) throw new Error(`The contract has no ${rule.method} ${route.path}`);
  return {
    ...rule,
    segments: route.path.split("/"),
    operation,
    queryKeys: Object.keys(operation.query?.shape ?? {}),
    binary: Object.values(operation.responses).some((response) => response.kind === "binary"),
  };
});

/**
 * The relayed route a request addresses, or null when it isn't one (notes, settings, sync,
 * device routes, unknown paths and methods: all stay local). Ids must be runtime ids once
 * decoded; anything else is left to the local routes, which reject it.
 */
export function matchRelayRoute(method: string, url: URL): RelayRoute | null {
  const segments = url.pathname.split("/");
  for (const rule of COMPILED) {
    if (rule.method !== method || rule.segments.length !== segments.length) continue;
    const path = matchSegments(rule.segments, segments);
    if (path === null) continue;
    const query = new URLSearchParams();
    for (const key of rule.queryKeys) {
      const value = url.searchParams.get(key);
      if (value !== null) query.set(key, value);
    }
    const search = query.size > 0 ? `?${query.toString()}` : "";
    return {
      name: rule.name,
      method: rule.method,
      kind: rule.kind,
      target: `${path}${search}`,
      body: rule.operation.body,
      binary: rule.binary,
    };
  }
  return null;
}

function matchSegments(pattern: readonly string[], actual: readonly string[]): string | null {
  const out: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]!;
    const segment = actual[i]!;
    if (!expected.startsWith(":")) {
      if (segment !== expected) return null;
      out.push(segment);
      continue;
    }
    const id = decodeSegment(segment);
    if (id === null || !RUNTIME_ID_PATTERN.test(id)) return null;
    out.push(encodeURIComponent(id));
  }
  return out.join("/");
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

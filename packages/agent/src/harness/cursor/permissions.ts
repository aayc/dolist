import type { WebTool } from "./monitor";
import type { AcpPermissionRequest } from "./protocol";

export type PermissionRoute =
  /** A call to our MCP server: allowed here, the bridge gates the call itself. */
  | { type: "bridge" }
  /** The CLI's web search or fetch: decided by the safety gate as `web_search` / `web_fetch`. */
  | { type: "web"; tool: WebTool; input: Record<string, string>; value: string }
  | { type: "reject"; what: string };

/**
 * Routes a `session/request_permission` from the CLI. Our MCP calls are recognized by the tool
 * call the CLI reported for them (`isBridgeCall`), never by title: titles of the CLI's question
 * prompts are chosen by the model and reuse the same allow options. Web search and fetch are
 * recognized by the kind the CLI sets for them. Anything else is rejected.
 */
export function routePermission(
  request: AcpPermissionRequest,
  isBridgeCall: (toolCallId: string) => boolean,
): PermissionRoute {
  if (isBridgeCall(request.toolCallId)) return { type: "bridge" };
  const title = request.title.trim();
  if (request.kind === "search" && /^web search:/i.test(title)) {
    const query = title.slice(title.indexOf(":") + 1).trim();
    if (query) return { type: "web", tool: "web_search", input: { query }, value: query };
  }
  if (request.kind === "fetch" && /^fetch\s+\S/i.test(title)) {
    const url = title.replace(/^fetch\s+/i, "").trim();
    return { type: "web", tool: "web_fetch", input: { url }, value: url };
  }
  return {
    type: "reject",
    what: `${request.kind || "unknown"}: ${title || "untitled"}`.slice(0, 160),
  };
}

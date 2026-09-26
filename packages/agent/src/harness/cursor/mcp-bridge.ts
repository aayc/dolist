/**
 * The MCP server through which the Cursor CLI reaches our tools: one HTTP listener per harness on
 * 127.0.0.1 (ephemeral port), one endpoint per session (`/mcp/<random key>`) with its own random
 * bearer token. It implements the Streamable HTTP subset the CLI's MCP client uses: POST with JSON
 * responses (notifications get 202), GET → 405, DELETE → 200; `initialize`, `ping`, `tools/list`,
 * `tools/call` and `notifications/cancelled`. Requests with a foreign Host, any Origin (browsers),
 * a wrong token or an oversized body are refused before they are parsed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { errorMessage, isRecord, type JsonSchema, type Logger, silentLogger } from "@ddl/core";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/** One session's tools, served on its endpoint. */
export interface McpSessionHandler {
  listTools(): McpTool[];
  /** Must not throw; `signal` aborts when the client cancels or disconnects. */
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpToolResult>;
}

export interface McpRegistration {
  url: string;
  /** Bearer token for the Authorization header. Held in memory only. */
  token: string;
  unregister(): void;
}

export interface McpBridgeOptions {
  serverName: string;
  serverVersion?: string;
  maxBodyBytes?: number;
  logger?: Logger;
}

interface Endpoint {
  handler: McpSessionHandler;
  tokenHash: Buffer;
  inFlight: Map<string, AbortController>;
}

type JsonRpcId = string | number;

class HttpError extends Error {
  readonly status: number;
  readonly rpcCode: number | undefined;

  constructor(status: number, message: string, rpcCode?: number) {
    super(message);
    this.status = status;
    this.rpcCode = rpcCode;
  }
}

export class McpBridge {
  private readonly options: McpBridgeOptions;
  private readonly logger: Logger;
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly server: http.Server;
  private listening: Promise<void> | undefined;
  private port = 0;

  constructor(options: McpBridgeOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ component: "mcp-bridge" });
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.logger.warn("MCP bridge request failed", { error: errorMessage(error) });
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  }

  /** Starts listening on 127.0.0.1 (idempotent). */
  start(): Promise<void> {
    this.listening ??= new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
    return this.listening;
  }

  get address(): { host: string; port: number } {
    return { host: "127.0.0.1", port: this.port };
  }

  register(handler: McpSessionHandler): McpRegistration {
    if (!this.port) throw new Error("The MCP bridge is not listening");
    const key = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("hex");
    this.endpoints.set(key, { handler, tokenHash: sha256(token), inFlight: new Map() });
    return {
      url: `http://127.0.0.1:${this.port}/mcp/${key}`,
      token,
      unregister: () => {
        const endpoint = this.endpoints.get(key);
        if (!endpoint) return;
        this.endpoints.delete(key);
        for (const controller of endpoint.inFlight.values()) controller.abort();
      },
    };
  }

  async close(): Promise<void> {
    for (const endpoint of this.endpoints.values()) {
      for (const controller of endpoint.inFlight.values()) controller.abort();
    }
    this.endpoints.clear();
    if (!this.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return this.reject(req, res, 403, "Forbidden host");
    }
    if (req.headers.origin !== undefined) return this.reject(req, res, 403, "Forbidden origin");
    const match = /^\/mcp\/([0-9a-f]{32})$/.exec(
      new URL(req.url ?? "/", "http://127.0.0.1").pathname,
    );
    const endpoint = match ? this.endpoints.get(match[1]!) : undefined;
    if (!endpoint) return this.reject(req, res, 404, "Not found");
    if (!validToken(req.headers.authorization, endpoint.tokenHash)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return this.reject(req, res, 401, "Unauthorized");
    }
    if (req.method === "GET") {
      res.setHeader("Allow", "POST, DELETE");
      return this.reject(req, res, 405, "Method not allowed");
    }
    if (req.method === "DELETE") return this.reject(req, res, 200, "");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, DELETE");
      return this.reject(req, res, 405, "Method not allowed");
    }
    try {
      const contentType = req.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(contentType)) {
        throw new HttpError(415, "Content-Type must be application/json");
      }
      const version = req.headers["mcp-protocol-version"];
      if (typeof version === "string" && !MCP_PROTOCOL_VERSIONS.includes(version)) {
        throw new HttpError(400, `Unsupported MCP protocol version ${version}`);
      }
      const body = await readBody(req, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        throw new HttpError(400, "Parse error", -32700);
      }
      await this.dispatch(message, endpoint, res);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.rpcCode === undefined) return this.reject(req, res, error.status, error.message);
      sendJson(res, error.status, {
        jsonrpc: "2.0",
        id: null,
        error: { code: error.rpcCode, message: error.message },
      });
    }
  }

  private async dispatch(message: unknown, endpoint: Endpoint, res: http.ServerResponse) {
    if (Array.isArray(message))
      throw new HttpError(400, "Batch requests are not supported", -32600);
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      throw new HttpError(400, "Invalid request", -32600);
    }
    const { id, method } = message;
    if (typeof method !== "string") {
      // A response to a server request; we never send any.
      res.writeHead(202).end();
      return;
    }
    if (id === undefined) {
      this.notification(method, message.params, endpoint);
      res.writeHead(202).end();
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      throw new HttpError(400, "Invalid request id", -32600);
    }
    const reply = (payload: { result: unknown } | { error: { code: number; message: string } }) =>
      sendJson(res, 200, { jsonrpc: "2.0", id, ...payload });
    switch (method) {
      case "initialize":
        return reply({ result: this.initialize(message.params) });
      case "ping":
        return reply({ result: {} });
      case "tools/list":
        return reply({ result: { tools: endpoint.handler.listTools() } });
      case "tools/call": {
        const params = isRecord(message.params) ? message.params : {};
        const args = params.arguments;
        if (typeof params.name !== "string" || (args !== undefined && !isRecord(args))) {
          return reply({ error: { code: -32602, message: "Invalid params" } });
        }
        return reply({ result: await this.callTool(endpoint, id, params.name, args ?? {}, res) });
      }
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  private initialize(params: unknown) {
    const requested = isRecord(params) ? params.protocolVersion : undefined;
    const protocolVersion =
      typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.options.serverName, version: this.options.serverVersion ?? "1.0.0" },
    };
  }

  private async callTool(
    endpoint: Endpoint,
    id: JsonRpcId,
    name: string,
    args: unknown,
    res: http.ServerResponse,
  ): Promise<McpToolResult> {
    const key = String(id);
    const controller = new AbortController();
    endpoint.inFlight.set(key, controller);
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);
    try {
      return await endpoint.handler.callTool(name, args, controller.signal);
    } finally {
      res.off("close", onClose);
      if (endpoint.inFlight.get(key) === controller) endpoint.inFlight.delete(key);
    }
  }

  private notification(method: string, params: unknown, endpoint: Endpoint): void {
    if (method !== "notifications/cancelled" || !isRecord(params)) return;
    const requestId = params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    endpoint.inFlight.get(String(requestId))?.abort();
  }

  private reject(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    status: number,
    text: string,
  ) {
    req.resume();
    if (res.headersSent) return;
    const headers: Record<string, string> = text
      ? { "content-type": "text/plain; charset=utf-8" }
      : {};
    if (status === 413) headers.connection = "close";
    res.writeHead(status, headers);
    res.end(text);
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, "Request body too large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (size > limit) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function validToken(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match ? timingSafeEqual(sha256(match[1]!), expected) : false;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

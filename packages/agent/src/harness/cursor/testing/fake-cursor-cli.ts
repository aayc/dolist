/**
 * A deterministic stand-in for the Cursor CLI, spawned by the Cursor harness tests (never
 * imported): `status --format json` and `acp`, the ACP subset the real CLI speaks, with a real
 * MCP client for the session's HTTP MCP server. Prompts are scripts, one command per line:
 *
 *   !say <text>                 reply (streamed in two chunks)
 *   !think <text>               thought chunk
 *   !call <tool> <json>         call an MCP tool through the session's server, then say the result
 *   !list                       say the MCP server's tool names
 *   !builtin <kind> | <title> | <rawInput json> | <rawOutput json or ->   report a built-in tool call
 *   !websearch <query>          ask permission for a web search, then report it like the CLI
 *   !webfetch <url>             ask permission for a web fetch, then report it like the CLI
 *   !permission <kind> | <title>  ask a generic permission, then say the chosen option
 *   !todo                       report a todo update (and send cursor/update_todos)
 *   !stream <n> <ms>            n chunks, ms apart
 *   !sleep <ms>                 wait (a cancel ends the turn)
 *   !hang                       never end the turn, ignoring cancel
 *   !crash                      exit with code 3
 *   !agents / !env / !model / !cli   say AGENTS.md, the environment, the model, the CLI configs
 *
 * Other text is acknowledged with `ok: <text>`. Options go before the command (the harness only
 * forwards a minimal environment): `--fake-auth=signed_out|garbage|hang`, `--fake-no-load`,
 * `--fake-no-http`, `--fake-protocol=<n>`, `--fake-new-error`, `--fake-ask-mcp` (ask permission
 * for MCP calls, as the real CLI does in allowlist mode), `--fake-pids=<file>` (append pids) and
 * `--fake-helper` (start a helper process in the same group, like the CLI's worker server).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

type Json = Record<string, unknown>;

const MODELS = [
  { modelId: "composer-2.5[fast=true]", name: "Composer 2.5" },
  { modelId: "gpt-5.5[context=272k,reasoning=medium,fast=false]", name: "GPT-5.5" },
  { modelId: "sonnet-4.6[thinking=true]", name: "Sonnet 4.6" },
];

interface McpServer {
  name: string;
  url: string;
  token: string;
}

interface Session {
  id: string;
  cwd: string;
  model: string;
  mcp: McpServer | undefined;
  mcpReady: boolean;
  transcript: Array<{ role: "user" | "agent"; text: string }>;
}

const env = process.env;
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const found = args.find((a) => a === `--fake-${name}` || a.startsWith(`--fake-${name}=`));
  return found === undefined ? undefined : (found.split("=")[1] ?? "1");
};
const sessions = new Map<string, Session>();
const pending = new Map<number, (value: Json) => void>();
let nextId = 1;
let current: { sessionId: string; controller: AbortController } | undefined;

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function request(method: string, params: Json): Promise<Json> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function update(sessionId: string, value: Json): void {
  send({ method: "session/update", params: { sessionId, update: value } });
}

function storeDir(id: string): string {
  return path.join(env.CURSOR_CONFIG_DIR ?? ".", "acp-sessions", id);
}

function persist(session: Session): void {
  mkdirSync(storeDir(session.id), { recursive: true });
  writeFileSync(
    path.join(storeDir(session.id), "meta.json"),
    JSON.stringify({ cwd: session.cwd, model: session.model, transcript: session.transcript }),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function mcpServer(servers: unknown): McpServer | undefined {
  const list = Array.isArray(servers) ? (servers as Json[]) : [];
  const server = list.find((s) => s.type === "http");
  if (!server || typeof server.url !== "string" || typeof server.name !== "string")
    return undefined;
  const headers = Array.isArray(server.headers) ? (server.headers as Json[]) : [];
  const auth = headers.find((h) => String(h.name).toLowerCase() === "authorization");
  const token = typeof auth?.value === "string" ? auth.value.replace(/^Bearer\s+/i, "") : "";
  return { name: server.name, url: server.url, token };
}

function post(server: McpServer, body: Json): Promise<{ status: number; body: Json | undefined }> {
  const url = new URL(server.url);
  const text = JSON.stringify({ jsonrpc: "2.0", ...body });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${server.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "content-length": Buffer.byteLength(text),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data ? (JSON.parse(data) as Json) : undefined,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

async function mcp(session: Session, method: string, params: Json): Promise<Json> {
  const server = session.mcp;
  if (!server) throw new Error("no MCP server");
  if (!session.mcpReady) {
    await post(server, {
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fake-cursor", version: "1" },
      },
    });
    await post(server, { method: "notifications/initialized" });
    session.mcpReady = true;
  }
  const response = await post(server, { id: nextId++, method, params });
  if (response.status !== 200 || !response.body) throw new Error(`MCP HTTP ${response.status}`);
  if (response.body.error) throw new Error(JSON.stringify(response.body.error));
  return response.body.result as Json;
}

async function say(session: Session, text: string, out: string[]): Promise<void> {
  const half = Math.ceil(text.length / 2);
  for (const part of [text.slice(0, half), text.slice(half)]) {
    if (part)
      update(session.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: part },
      });
  }
  out.push(text);
}

function toolCall(session: Session, id: string, fields: Json): void {
  update(session.id, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    status: "pending",
    rawInput: {},
    ...fields,
  });
}

function toolUpdate(session: Session, id: string, fields: Json): void {
  update(session.id, { sessionUpdate: "tool_call_update", toolCallId: id, ...fields });
}

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

async function permission(
  session: Session,
  toolCall: Json,
  options = PERMISSION_OPTIONS,
): Promise<string> {
  const result = await request("session/request_permission", {
    sessionId: session.id,
    toolCall,
    options,
  });
  const outcome = (result.outcome ?? {}) as Json;
  return outcome.outcome === "selected" ? String(outcome.optionId) : "cancelled";
}

async function runCommand(session: Session, line: string, signal: AbortSignal, out: string[]) {
  const [command = "", ...rest] = line.slice(1).split(" ");
  const arg = rest.join(" ");
  switch (command) {
    case "say":
      return say(session, arg, out);
    case "think":
      update(session.id, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: arg },
      });
      return;
    case "list": {
      const result = await mcp(session, "tools/list", {});
      const tools = (result.tools as Json[]).map((t) => String(t.name));
      return say(session, `tools: ${tools.join(",")}`, out);
    }
    case "call": {
      const [tool = "", ...json] = rest;
      const args = json.length > 0 ? (JSON.parse(json.join(" ")) as Json) : {};
      const id = `tool_${randomBytes(6).toString("hex")}`;
      toolCall(session, id, { title: "MCP: tool", kind: "other" });
      toolUpdate(session, id, {
        title: `${session.mcp?.name}: ${tool}`,
        rawInput: { providerIdentifier: session.mcp?.name, toolName: tool, args },
      });
      toolUpdate(session, id, { status: "in_progress" });
      if (option("ask-mcp")) {
        const choice = await permission(session, {
          toolCallId: id,
          title: `${session.mcp?.name}-${tool}: ${tool}`,
          kind: "other",
          status: "pending",
        });
        if (choice !== "allow-once") {
          toolUpdate(session, id, { status: "completed", rawOutput: { permissionDenied: true } });
          return say(session, `result(${tool}): permission ${choice}`, out);
        }
      }
      const result = await mcp(session, "tools/call", { name: tool, arguments: args });
      toolUpdate(session, id, { status: "completed", rawOutput: { success: true } });
      const text = (result.content as Json[])
        .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
        .join("");
      return say(session, `result(${tool})${result.isError ? " error" : ""}: ${text}`, out);
    }
    case "builtin": {
      const [kind = "other", title = "", rawInput = "{}", rawOutput = "-"] = arg.split(" | ");
      const id = `tool_${randomBytes(6).toString("hex")}`;
      toolCall(session, id, { title: "Tool", kind });
      toolUpdate(session, id, { title, rawInput: JSON.parse(rawInput) as Json });
      toolUpdate(session, id, { status: "in_progress" });
      toolUpdate(session, id, {
        status: "completed",
        ...(rawOutput.trim() === "-" ? {} : { rawOutput: JSON.parse(rawOutput) as Json }),
      });
      return;
    }
    case "websearch":
    case "webfetch": {
      const search = command === "websearch";
      const choice = await permission(session, {
        toolCallId: search ? "web_search_0" : "web_fetch_0",
        title: search ? `Web search: ${arg}` : `Fetch ${arg}`,
        kind: search ? "search" : "fetch",
        status: "pending",
      });
      const id = `tool_${randomBytes(6).toString("hex")}`;
      toolCall(session, id, {
        title: search ? "Web Search" : "Web Fetch",
        kind: search ? "search" : "fetch",
      });
      toolUpdate(session, id, { rawInput: search ? { searchTerm: arg } : { url: arg } });
      toolUpdate(session, id, { status: "in_progress" });
      const allowed = choice === "allow-once";
      toolUpdate(session, id, {
        status: "completed",
        rawOutput: allowed
          ? search
            ? { referenceCount: 3 }
            : { success: true }
          : { rejected: true, reason: "User rejected" },
      });
      return say(session, `${command}: ${choice}`, out);
    }
    case "permission": {
      const [kind = "other", title = ""] = arg.split(" | ");
      const choice = await permission(session, {
        toolCallId: `tool_${randomBytes(6).toString("hex")}`,
        title,
        kind,
        status: "pending",
      });
      return say(session, `permission: ${choice}`, out);
    }
    case "todo": {
      const id = `tool_${randomBytes(6).toString("hex")}`;
      toolCall(session, id, {
        title: "Update TODOs",
        kind: "other",
        rawInput: { _toolName: "updateTodos" },
      });
      toolUpdate(session, id, { status: "in_progress" });
      toolUpdate(session, id, { status: "completed" });
      await request("cursor/update_todos", { toolCallId: id, todos: [], merge: false });
      return;
    }
    case "stream": {
      const [count = "10", ms = "10"] = rest;
      for (let i = 0; i < Number(count) && !signal.aborted; i++) {
        update(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `w${i} ` },
        });
        await sleep(Number(ms), signal);
      }
      return;
    }
    case "sleep":
      return sleep(Number(arg), signal);
    case "hang":
      return new Promise<void>(() => {});
    case "crash":
      return process.exit(3);
    case "agents":
      return say(session, readFileSync(path.join(session.cwd, "AGENTS.md"), "utf8"), out);
    case "env":
      return say(
        session,
        JSON.stringify({
          keys: Object.keys(env).sort(),
          config: env.CURSOR_CONFIG_DIR,
          data: env.CURSOR_DATA_DIR,
        }),
        out,
      );
    case "model":
      return say(session, `model: ${session.model}`, out);
    case "cli": {
      const project = readFileSync(path.join(session.cwd, ".cursor", "cli.json"), "utf8");
      const global = readFileSync(
        path.join(env.CURSOR_CONFIG_DIR ?? ".", "cli-config.json"),
        "utf8",
      );
      return say(
        session,
        JSON.stringify({ project: JSON.parse(project), global: JSON.parse(global) }),
        out,
      );
    }
    default:
      return say(session, `unknown command ${command}`, out);
  }
}

async function prompt(session: Session, params: Json): Promise<Json> {
  const blocks = Array.isArray(params.prompt) ? (params.prompt as Json[]) : [];
  const text = blocks
    .map((b) => (b.type === "text" ? String(b.text) : `[${String(b.type)}]`))
    .join("\n");
  session.transcript.push({ role: "user", text });
  const controller = new AbortController();
  current = { sessionId: session.id, controller };
  const out: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (controller.signal.aborted) break;
    if (line.startsWith("!")) await runCommand(session, line, controller.signal, out);
  }
  if (!lines.some((line) => line.startsWith("!")) && !controller.signal.aborted) {
    await say(session, `ok: ${text.slice(0, 200)}`, out);
  }
  current = undefined;
  session.transcript.push({ role: "agent", text: out.join("\n") });
  persist(session);
  return { stopReason: controller.signal.aborted ? "cancelled" : "end_turn" };
}

async function handle(message: Json): Promise<Json | undefined> {
  const params = (message.params ?? {}) as Json;
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: Number(option("protocol") ?? 1),
        agentCapabilities: {
          loadSession: !option("no-load"),
          mcpCapabilities: { http: !option("no-http"), sse: true },
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
        authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
      };
    case "session/new": {
      if (option("new-error"))
        throw Object.assign(new Error("Authentication required"), { code: -32000 });
      const session: Session = {
        id: `fake-${randomBytes(6).toString("hex")}`,
        cwd: String(params.cwd),
        model: MODELS[0]!.modelId,
        mcp: mcpServer(params.mcpServers),
        mcpReady: false,
        transcript: [],
      };
      sessions.set(session.id, session);
      persist(session);
      return {
        sessionId: session.id,
        modes: {
          currentModeId: "agent",
          availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
        },
        models: { currentModelId: session.model, availableModels: MODELS },
      };
    }
    case "session/load": {
      const id = String(params.sessionId);
      const stored = JSON.parse(readFileSync(path.join(storeDir(id), "meta.json"), "utf8")) as Json;
      const session: Session = {
        id,
        cwd: String(params.cwd),
        model: String(stored.model),
        mcp: mcpServer(params.mcpServers),
        mcpReady: false,
        transcript: stored.transcript as Session["transcript"],
      };
      sessions.set(id, session);
      for (const entry of session.transcript) {
        update(id, {
          sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: entry.text },
        });
      }
      return { models: { currentModelId: session.model, availableModels: MODELS } };
    }
    case "session/set_model": {
      const session = sessions.get(String(params.sessionId));
      const wanted = String(params.modelId);
      const base = wanted.split("[")[0];
      if (!session || !MODELS.some((m) => m.modelId.split("[")[0] === base)) {
        throw Object.assign(new Error(`Invalid model ${wanted}`), { code: -32602 });
      }
      session.model = wanted;
      return {};
    }
    case "session/prompt": {
      const session = sessions.get(String(params.sessionId));
      if (!session) throw new Error("unknown session");
      return prompt(session, params);
    }
    case "session/cancel":
      if (current && current.sessionId === params.sessionId) current.controller.abort();
      return undefined;
    default:
      throw Object.assign(new Error(`Method not found: ${String(message.method)}`), {
        code: -32601,
      });
  }
}

function acp(): void {
  const pids = option("pids");
  if (pids) appendFileSync(pids, `${process.pid}\n`);
  if (option("helper")) {
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (pids) appendFileSync(pids, `${helper.pid}\n`);
  }
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Json;
      if (message.method === undefined && typeof message.id === "number") {
        pending.get(message.id)?.((message.result ?? { error: message.error }) as Json);
        pending.delete(message.id);
        continue;
      }
      const id = message.id;
      handle(message).then(
        (result) => {
          if (id !== undefined) send({ id, result: result ?? null });
        },
        (error: Error & { code?: number }) => {
          if (id !== undefined)
            send({ id, error: { code: error.code ?? -32603, message: error.message } });
        },
      );
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function status(): void {
  const auth = option("auth");
  if (auth === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (auth === "garbage") {
    process.stdout.write("Not logged in? Something unexpected happened.\n");
    return;
  }
  const signedIn = auth !== "signed_out";
  process.stdout.write(
    `${JSON.stringify({ status: signedIn ? "authenticated" : "unauthenticated", isAuthenticated: signedIn, userInfo: { email: "someone@example.com" } })}\n`,
  );
}

const command = args.find((a) => !a.startsWith("--"));
if (command === "acp") acp();
else if (command === "status") status();
else {
  process.stderr.write(`fake-cursor-cli: unknown command ${String(command)}\n`);
  process.exit(2);
}

/**
 * Minimal stdio MCP server for the connector process-lifecycle tests. Plain JS so it runs as a child
 * process without a TypeScript loader.
 *
 * Environment:
 *   FIXTURE_LABEL         prefix for echo replies (default "echo")
 *   FIXTURE_CRASH_MARKER  file path; while the file exists the server exits at startup
 */
import { existsSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const label = process.env.FIXTURE_LABEL ?? "echo";
const crashMarker = process.env.FIXTURE_CRASH_MARKER;

if (crashMarker && existsSync(crashMarker)) {
  process.stderr.write("fixture: refusing to start (crash marker present)\n");
  process.exit(3);
}
process.stderr.write(`fixture ${label} started\n`);

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

const server = new Server(
  { name: `fixture-${label}`, version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "pid",
      description: "Returns the server's process id.",
      inputSchema: { type: "object" },
    },
    {
      name: "env",
      description: "Returns one environment variable of the server process.",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
    },
    {
      name: "crash",
      description: "Exits the process without answering.",
      inputSchema: { type: "object", properties: { persist: { type: "boolean" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "echo":
      return text(`${label}: ${args.text}`);
    case "pid":
      return text(process.pid);
    case "env":
      return text(process.env[String(args.name)] ?? "<unset>");
    case "crash":
      if (args.persist && crashMarker) writeFileSync(crashMarker, "1");
      process.stderr.write("fixture: crashing on purpose\n");
      process.exit(1);
      break;
    default:
      return { ...text(`unknown tool ${request.params.name}`), isError: true };
  }
});

await server.connect(new StdioServerTransport());
// Exit as soon as the client closes stdin, like well-behaved MCP servers.
process.stdin.on("end", () => process.exit(0));

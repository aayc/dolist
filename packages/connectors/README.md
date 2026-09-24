# @ddl/connectors

Connects Daily Do List agents to external services through [MCP](https://modelcontextprotocol.io)
servers (stdio, streamable HTTP, legacy SSE) and exposes their tools as harness-agnostic `ToolSpec`s
named `mcp__<server>__<tool>`. Every connector tool call goes through the safety gate like any other
tool; this package only adds hints, it never bypasses the gate.

Built on the official `@modelcontextprotocol/sdk`, following the adapter pattern of OpenClaw and
Hermes Agent (see [NOTICE.md](./NOTICE.md)).

## Configuration

The daemon reads **`$DDL_HOME/mcp.json`** (default `~/.daily-do-list/mcp.json`). The format is the
`mcpServers` file used by Claude Desktop, Cursor and Claude Code, so existing snippets paste in
unchanged:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"],
      "approval": "writes"
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "approval": "writes"
    }
  }
}
```

OpenClaw's (and VS Code settings') `{ "mcp": { "servers": { … } } }` shape is accepted too; if both
are present they are merged and `mcpServers` wins on duplicate names.
[`mcp.example.json`](./mcp.example.json) lists curated, disabled-by-default examples (Playwright,
filesystem, GitHub, Notion, and a community Google Workspace server); the same data is exported as
`CONNECTOR_CATALOG` for the settings UI.

| Option             | Servers   | Default    | Meaning                                                                    |
| ------------------ | --------- | ---------- | -------------------------------------------------------------------------- |
| `type`             | all       | inferred   | `stdio` (inferred from `command`), `http` (inferred from `url`), or `sse`   |
| `command`, `args`  | stdio     | –          | Executable and arguments; no shell is involved                             |
| `env`              | stdio     | `{}`       | Variables for the server process (see below)                               |
| `cwd`              | stdio     | inherited  | Working directory; must exist                                              |
| `url`, `headers`   | http, sse | –          | Endpoint and extra HTTP headers                                            |
| `enabled`          | all       | `true`     | Disabled servers are listed as `disabled` and never started                |
| `approval`         | all       | `"auto"`   | `auto`, `writes` or `always` (see [Safety](#safety))                       |
| `toolFilter`       | all       | –          | `{ "include": [...], "exclude": [...] }`: exact names or `*` globs          |
| `description`      | all       | –          | Shown in the UI and prefixed to each tool description for the model        |
| `connectTimeoutMs` | all       | `30000`    | Start + initialize + list tools                                            |
| `requestTimeoutMs` | all       | `120000`   | Per tool call                                                              |

`http` means streamable HTTP, falling back to legacy SSE when the server rejects it. Aliases are
accepted: `transport` (OpenClaw; `streamable-http` = `http`), `connectionTimeoutMs`, and
`disabled: true`. Keys other clients write into the same file (`autoApprove`, `alwaysAllow`,
`disabledTools`, `timeout`) are ignored with a warning. Any other unknown key is an error, so a typo
such as `"aproval"` cannot quietly weaken a server's posture.

Validation is per server. An invalid server appears in `status()` as `error` with every problem
listed, and the others keep working. A file that is not valid JSON makes `loadConnectorsConfig`
throw `ConnectorConfigError` (keep the previous config); a missing file is an empty config.

### Secrets and environment variables

Never put secrets in `mcp.json`. Use placeholders; they are resolved **at connect time** from the
daemon's environment (for example `~/.daily-do-list/.env`):

| Syntax              | Meaning                                  |
| ------------------- | ---------------------------------------- |
| `${NAME}`, `$NAME`  | Value of `NAME`                          |
| `${env:NAME}`       | Same (Cursor syntax)                     |
| `${NAME:-fallback}` | `fallback` when `NAME` is unset or empty |
| `$$`                | A literal `$`                            |

Placeholders work in `command`, `args`, `env` values, `cwd`, `url` and `headers` values. A missing
variable puts that server in `error` — e.g. `Environment variable not set: GITHUB_TOKEN (in
headers.Authorization)` — without starting it. Placeholders don't nest: a default such as
`${A:-${B}}` is an error rather than a silently wrong value. Messages name variables and fields,
never values.

A stdio server receives only the SDK's safe defaults (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`,
`USER`) plus the `env` you configure, never the daemon's full environment, so pass what it needs
explicitly: `"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }`. A leading `~` is
expanded in `command` and `cwd`; `args` are passed verbatim.

## Safety

Connector tools are ordinary `ToolSpec`s, so the harness runs every call through the `SafetyGate`
(policy → rules → LLM judge) before it executes. MCP tool annotations become hints, using the MCP
spec's defaults:

| `ToolSafetyHints`       | Derived from                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `readOnly`              | `readOnlyHint === true` (default `false`)                              |
| `destructive`           | `destructiveHint`, default `true`; always `false` for read-only tools  |
| `openWorld`             | `openWorldHint`, default `true`                                        |
| `alwaysRequireApproval` | the server's `approval` posture                                        |
| `describe(input)`       | `github · create_issue(owner: "acme", title: "Fix login")`             |

Approval postures:

- **`auto`** (default): the safety evaluator decides each call using the hints above.
- **`writes`**: every tool not annotated `readOnlyHint: true` needs approval. Good for mail,
  calendars and file access.
- **`always`**: every call needs approval.

Annotations come from the server and are **untrusted**. Under `writes`, a tool falsely marked
read-only skips the forced approval, although the evaluator still judges it. Use `always` for servers
you don't fully trust. Posture changes apply immediately, even to tool specs already held by running
sessions; a removed or disabled server's tools fail closed. In `describe()` output, values under
credential-like keys (`token`, `password`, `api_key`, …) and well-known token formats are masked
as `•••`.

## Tool names

`mcp__<server>__<tool>`: characters outside `[A-Za-z0-9_-]` become `_`; names longer than 64
characters are clamped with an 8-hex SHA-256 suffix. When two tools map to the same name (e.g.
`read.file` and `read_file`, compared case-insensitively), the first in sorted order keeps it and the
others get a hash suffix. Naming depends only on the set of tools, never on connection order.

## Input schemas

`inputSchema` becomes an object schema with `properties`: `required` keeps declared properties
only, root `allOf`/`anyOf`/`oneOf` are folded into the root, root `$schema`/`$id`/`not`/`enum`/
`const` are dropped, and so are a root `description`/`title` that are not strings. The rest is
kept as plain JSON: `__proto__` keys, non-JSON values and cycles are removed. `$ref`s are left for
the harness to resolve.

## Results

MCP output is untrusted and is projected into `ToolResult`:

- **Text and images**: text passes through; images the models accept (PNG, JPEG, GIF, WebP, up to
  about 6 MB each and about 12 MB per result) are passed on as images. Image data is normalized to
  standard base64 (`data:` URL prefixes, line breaks, URL-safe or unpadded base64 are accepted);
  data that is not base64 becomes a placeholder, since one undecodable image makes providers
  reject the whole request.
- **Other binary content**: audio and other binaries become short placeholders.
- **Resources**: embedded resource text gets a `[Resource: <uri>]` header; resource links become
  text.
- **Structured output**: `structuredContent` goes to `details`, and is also added as JSON text when
  there is no other text.
- **Errors**: `isError` is preserved. JSON-RPC errors from a live server (bad arguments, unknown
  tool) become error results the model can react to. Infrastructure failures are thrown as typed
  `ConnectorError`s (`McpUnavailableError`, `McpTimeoutError`, `McpTransportError`, …).
- **Size limit**: text is capped at 100,000 characters per result.

## Lifecycle

- The first `getTools()` connects every enabled server in parallel. Failures are reported through
  `status()`/`onStatus()`, never thrown.
- Tool lists are cached and refreshed on `notifications/tools/list_changed` and after reconnects.
  Malformed tool entries are skipped one by one, and each server is capped at 500 tools.
- **Unexpected disconnect** (crash, closed stream): up to 5 background reconnects with jittered
  exponential backoff (1 s, 2 s, 4 s, …, ±20%). Calls wait for the reconnect within their own
  timeout, and the tools stay listed meanwhile.
- **Repeated failure**: when those attempts are exhausted, or a lazy connect fails, the server
  enters `error` and is left alone for 60 s. The next use after that tries again.
- **HTTP transport choice**: streamable HTTP comes first. Legacy SSE is tried only when the very
  first connection is rejected for a reason other than a timeout or 401/403. The transport that
  worked is kept.
- **`reload(config)`**: unchanged servers keep their process; changes to `approval`, `toolFilter`,
  `description` or `requestTimeoutMs` apply in place; launch changes restart the server; removed
  servers are closed.
- **Closing stdio servers**: `dispose()` and closing a server end its stdin, then send SIGTERM, then
  SIGKILL.

## Troubleshooting

`GET /api/connectors` returns `ConnectorStatus[]`: `state` (`idle`, `connecting`, `connected`,
`error`, `disabled`), `toolCount`, `transport` actually in use, and `error`. Error messages include
the last lines of a stdio server's stderr. The full stderr is logged at `debug` level with secrets
masked.

| Error                                                   | Fix                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Command not found: "npx"`                              | The daemon's `PATH` can differ from your shell's (GUI launch); use an absolute path     |
| `Environment variable not set: …`                       | Add it to `~/.daily-do-list/.env` and restart the daemon                              |
| `did not finish starting up within 30000 ms`            | First `npx` runs download packages; raise `connectTimeoutMs` or install it globally   |
| `closed the connection during startup (stderr: …)`      | The server crashed while starting; the stderr excerpt says why                        |
| `Authentication failed (HTTP 401)`                      | Check the token in `headers`; OAuth sign-in (e.g. Notion's remote server) isn't supported yet |
| `is unavailable: … (next attempt in N s)`               | Cooling down after failures; fix the cause, then wait or reload the config            |

## API

```ts
import { join } from "node:path";
import { CONNECTORS_CONFIG_FILE, createConnectorManager, loadConnectorsConfig } from "@ddl/connectors";

const path = join(home, CONNECTORS_CONFIG_FILE);
const connectors = createConnectorManager(await loadConnectorsConfig(path), { logger });
const tools = await connectors.getTools(); // ToolSpec[]; hand them to the harness behind the safety gate
const stop = connectors.onStatus((status) => broadcast(status));
await connectors.reload(await loadConnectorsConfig(path)); // e.g. when the file changes
await connectors.dispose();
```

Also exported: `parseServerConfig` (validate one entry, e.g. before saving it from the settings UI),
`normalizeConnectorsConfig`, `CONNECTOR_CATALOG` / `catalogExampleConfig`, `mcpToolName` /
`assignToolNames`, `projectCallToolResult`, `normalizeInputSchema` and the error classes.

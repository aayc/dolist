# Third-party code in @ddl/connectors

Parts of this package are adapted from the MIT-licensed projects below. Each adapted file names
its source in a header comment. This list is merged into the repository's `THIRD_PARTY_NOTICES.md`
together with the full license texts.

## OpenClaw

MIT License, Copyright (c) 2026 OpenClaw Foundation.

| File in this package | Adapted from                           | What                                                  |
| -------------------- | -------------------------------------- | ----------------------------------------------------- |
| `src/filter.ts`      | `src/agents/mcp-tool-filter.ts`        | Include-then-exclude tool filter with `*` globs       |
| `src/content.ts`     | `src/agents/mcp-content.ts`            | Projection of `CallToolResult` content blocks         |
| `src/connection.ts`  | `src/agents/mcp-client-lifecycle.ts`   | Connect deadline race and client/transport disposal   |

## Hermes Agent

MIT License, Copyright (c) 2025 Nous Research.

| File in this package     | Adapted from                                             | What                                                        |
| ------------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| `src/names.ts`           | `tools/mcp_tool_schema.py` (`mcp_prefixed_tool_name`)    | `mcp__server__tool` naming, sanitizing, SHA-256 clamp suffix |
| `src/schema.ts`          | `tools/mcp_tool_schema.py` (`_repair_object_shape`)      | Object-shape repair and `required` pruning                  |
| `src/tool-definition.ts` | `tools/mcp_tool_schema.py` (`_MCP_INJECTION_PATTERNS`)   | Prompt-injection heuristics for tool descriptions           |
| `src/redact.ts`          | `tools/mcp_tool_common.py` (`_CREDENTIAL_PATTERN`)       | Credential patterns used for masking                        |
| `src/connection.ts`      | `tools/mcp_tool_common.py` (`_jittered`)                 | Jittered reconnect backoff                                  |

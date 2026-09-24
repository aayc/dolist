# Security Policy

Daily Do List runs on your machine with your privileges and lets AI agents act on your behalf, so we
take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
([direct link](../../security/advisories/new)). This creates a private advisory that only you and
the maintainers can see.

Please include:

- the affected component and version or commit,
- the impact: what an attacker can do, and under which preconditions,
- reproduction steps or a proof of concept, using synthetic data only (no real keys or notes),
- a suggested fix, if you have one.

We aim to acknowledge reports within 3 business days and to share an initial assessment within 10.
We coordinate disclosure with you: fixes ship first, and the advisory is published after that,
normally within 90 days. We credit reporters in the advisory unless you prefer otherwise.

## Supported versions

The project is pre-1.0 and under active development. Security fixes land on `main` only.

| Version | Supported |
| --- | --- |
| `main` (latest) | ✅ |
| Older commits and pre-releases | ❌ |

## Threat model (summary)

**Local daemon.** The daemon binds to `127.0.0.1` only. Every REST and WebSocket request must carry
a bearer token that is generated locally and kept in the app's home directory (`~/.daily-do-list`).
Requests with unexpected `Host` or `Origin` headers are rejected, which blocks DNS-rebinding and
cross-site requests from web pages. No unauthenticated endpoint reads the vault or triggers agent
work.

**Cursor harness MCP bridge.** With the Cursor CLI harness, the daemon also listens on an ephemeral
`127.0.0.1` port: the MCP endpoint through which the CLI calls this app's tools. Each agent session
gets its own random path and a random 32-byte bearer token (compared in constant time), handed only
to that session's CLI process. Requests with any `Origin` header or a `Host` other than
`127.0.0.1:<port>`/`localhost:<port>`, and oversized bodies, are refused before parsing. Every call
still goes through the safety gate. The CLI runs with a private config that denies its own file,
shell and fetch tools, and a minimal environment without API keys.

**Agent safety gate.** Every tool call from every agent passes the safety gate before it executes.
That includes built-in tools, the harness's shell and file tools, browser and computer control,
MCP connector tools, and the Cursor CLI's web search and fetch. The gate evaluates each call with policy, then rules, then an independent LLM
judge. Risky actions pause until you explicitly approve them in the UI: spending money, booking,
sending messages, deleting data, or changing your notes. The gate fails closed, so evaluator errors
or timeouts block the action.

**Untrusted content.** Web pages, emails, files and tool results that agents read may contain
prompt injection. The gate and approvals are the control that keeps injected instructions from
turning into risky actions without your consent.

**Secrets.** API keys live outside the repository, in `~/.daily-do-list/.env` or the process
environment. They are read at runtime and never logged. This public repository is scanned on every
commit and push: pre-commit and pre-push hooks, plus gitleaks and CodeQL in CI.

**MCP servers and execution.** MCP servers you configure in `~/.daily-do-list/mcp.json` run with
your user privileges; stdio servers are local processes. Their tools go through the safety gate, but
the servers themselves are trusted code, so only add servers you trust. The local execution provider
runs shell commands, a browser and (on macOS) computer control as your user. The safety gate and
approvals are the primary control, not OS sandboxing.

### In scope

Examples:

- bypassing the safety gate or approvals, or any tool that executes without the gate;
- prompt injection that leads to a risky action without approval;
- getting past the daemon's (or the Cursor harness MCP bridge's) token, `Host` or `Origin` checks,
  or reading the vault or agent state from a web page;
- getting the Cursor CLI to run one of its own tools (files, shell, fetch) under the Cursor harness;
- secrets leaking into logs, threads, artifacts or the repository;
- path traversal outside the vault or agent workspaces;
- script injection through rendered notes, agent threads or artifacts.

### Out of scope

- Attacks that already require code execution as your user, or root.
- Vulnerabilities in third-party MCP servers, model providers or dependencies. Report those
  upstream, but tell us if our usage makes them exploitable.
- Model output quality that doesn't bypass approvals. Please open a regular issue for that.
- Denial of service against your own local daemon, and social engineering.

## Staying safe as a user

- Keep the daemon on localhost. Don't expose its port through tunnels or reverse proxies.
- Read approval cards before approving, especially payments and outgoing messages.
- Only configure MCP servers you trust, and give connectors least-privilege tokens.
- Keep `~/.daily-do-list` private. It holds the daemon token, your API keys and agent state.

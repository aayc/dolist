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

**Sync service.** The optional, self-hosted sync service (`apps/sync`) is the one component meant
to be reachable from other devices, behind a TLS-terminating proxy. Each vault has its own random
32-byte token, stored only as a SHA-256 hash and compared in constant time; wrong tokens, other
vaults' tokens and unknown vaults all get the same 401. Paths are validated, bodies, files and vaults
are size-limited, each vault is rate-limited, and logs never contain tokens, contents or paths.
Vaults are administered with its CLI only. There is no end-to-end encryption yet, so whoever runs
the server can read the notes. Details: [docs/SYNC.md](docs/SYNC.md#security).

**Agent relay.** A device whose agent runs on the always-on machine forwards its agent routes and
events to that machine's daemon, using the device credential the machine issued it. The relay is
not an open proxy: it forwards only an allowlist of agent routes (threads, approvals, artifacts,
task records, routines, agent status; never notes, settings, sync or device routes), only to the
configured machine URL (`https`, plain `http` only to loopback), with the target rebuilt from
validated ids and declared query parameters. Nothing from the client's request is passed on (its
`Authorization`, cookies, `Host`, `Origin` or other headers): the relay sends only its own bearer
token, in a header, never in a URL. Bodies are validated and size-limited, redirects aren't
followed, calls time out, answers are size-limited, and the events the machine sends are validated
before local clients see them. The token and bodies are never logged. When the machine can't be
reached, the device shows the synced agent state read-only and refuses agent actions.

**Agent safety gate.** Every tool call from every agent passes the safety gate before it executes.
That includes built-in tools, the harness's shell and file tools, browser and computer control,
MCP connector tools, and the Cursor CLI's web search and fetch. The gate evaluates each call with policy, then rules, then an independent LLM
judge. Risky actions pause until you explicitly approve them in the UI: spending money, booking,
sending messages, deleting data, or changing your notes. The gate fails closed, so evaluator errors
or timeouts block the action.

**Approval policies.** Settings → Agent → Approvals chooses when agents ask: before every action
that changes something, for risky actions (the default), only for high-risk actions, or never
("Run everything", which asks you to confirm and stays visible in the status bar). The policy only
decides whether an allowed or approval-worthy action asks you; the evaluator's verdict is the same
under every policy, and actions it denies (deleting your home folder, reading keychains or
password stores, operating Daily Do List, System Settings or a password manager, …) stay blocked.
Agents can't change the policy: writing the vault's `.daily-do-list/` folder (settings, approval
state, threads) or `$DDL_HOME` (config, keys, tokens), code that names those files, and reaching
the daemon or the web dev server are hard denies. With "Run everything", programs an agent writes
and runs aren't inspected while they run, so choose it only for agents and tasks you trust.

**Untrusted content.** Web pages, emails, files and tool results that agents read may contain
prompt injection. The gate and approvals are the control that keeps injected instructions from
turning into risky actions without your consent.

**Computer use and app control (macOS).** With the Accessibility and Screen Recording permissions,
agents can operate your apps: screen-level (the real cursor and keyboard) or, with the
`ddl-computer` helper, one app at a time in the background through its accessibility tree. Every
action in another app needs your approval; only reading an app (its window, a screenshot, the app
list) doesn't. Approval cards and the safety rules see what the tool knows about the real target —
the app's real name and the element's label from the latest snapshot — alongside the model's own
description, and the action runs against exactly that snapshot (a changed window makes it stale
instead of hitting another element). Standing grants ("approve for this task") are scoped to one
app, where they cover any computer action no riskier than the approved one (a Return, a send or a
payment asks again). Return, typed line breaks and send buttons in messaging apps count as
sending a message.
Some apps are off-limits even with approval, refused by the safety rules by name and by the helper
by bundle id and process tree: Daily Do List itself (an agent could approve its own actions),
System Settings, Keychain Access and Passwords, password managers, authenticators, the system's
login and security prompts, and browser windows showing the Daily Do List web UI. The helper gets
a minimal environment without API keys. `POST /api/computer/permissions/open` (authenticated like
every route) only ever opens fixed System Settings deep links.

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
- an agent changing the approval policy, or a denied action running under any policy;
- an agent operating a protected app, or an approval card that names a different app or element
  than the one acted on;
- getting past the daemon's (or the Cursor harness MCP bridge's) token, `Host` or `Origin` checks,
  or reading the vault or agent state from a web page;
- reading or changing a vault on the sync service without its token, telling whether a vault id
  exists, or getting two devices to run the agent at once;
- getting the agent relay to forward anything but its allowlisted agent routes, to send a request
  anywhere but the configured always-on machine, or to leak its credential;
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
- Keep the approval policy at "Ask for risky actions" unless you have a reason to change it; "Run
  everything" lets agents spend money and send messages without asking.
- Grant computer use permissions only to the app that runs Daily Do List (Settings → Computer Use
  names it), and turn them off when you stop using computer use.
- Only configure MCP servers you trust, and give connectors least-privilege tokens.
- Keep `~/.daily-do-list` private. It holds the daemon token, your API keys, the sync token and
  agent state.
- If you run the sync service, serve it over HTTPS only, keep its database and backups private (it
  holds your notes), and rotate a vault's token (`vault rotate-token`) if a device is lost.

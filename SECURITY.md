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

- **Local daemon.** It binds `127.0.0.1` only; every REST and WebSocket request carries a bearer
  token generated locally in `~/.daily-do-list`, and unexpected `Host` or `Origin` headers are
  rejected (DNS rebinding, cross-site requests). No unauthenticated endpoint reads the vault or
  triggers agent work. Details: [the daemon README](apps/daemon/README.md#security-model).
- **Remote access (opt-in).** Other devices reach the daemon only through a private-network proxy
  on the same machine (`tailscale serve`), under remote hosts that are configured, never inferred,
  and only with device credentials: a paired app's token (stored as a hash) or a paired browser's
  HttpOnly cookie accepted only from its own page. The master token never leaves the machine, a
  loopback `Host` carrying proxy forwarding headers is refused, and pairing codes are single-use,
  short-lived and rate-limited. Tokens, cookies and codes are never logged; the secret files live
  `0600` in `$DDL_HOME`, never in synced settings or API responses, and agents are hard-denied
  access to them. Details: [remote access and pairing](apps/daemon/README.md#remote-access-and-pairing).
- **Agent relay.** A device whose agent runs on the always-on machine forwards only an allowlist of
  agent routes (never notes, settings, sync or device routes), only to the configured machine,
  with its own credential and nothing from the client's request; bodies and answers are validated
  and size-limited ([the relay](apps/daemon/README.md#the-agent-relay)).
- **Cursor harness MCP bridge.** An ephemeral `127.0.0.1` port with a random path and 32-byte
  token per session, no `Origin` accepted, every call through the safety gate; the Cursor CLI runs
  with its own tools denied and without API keys in its environment
  ([details](docs/AGENT_SYSTEM.md#5-the-cursor-cli-harness)).
- **Sync service.** The one component meant to be reachable from other devices, behind a TLS
  proxy: per-vault tokens stored as hashes, the same 401 for every failure, validated paths, size
  and rate limits, no tokens or contents in logs. There is no end-to-end encryption yet, so whoever
  runs the server can read the notes ([docs/SYNC.md](docs/SYNC.md#security)).
- **Agent safety gate.** Every tool call from every agent (built-in tools, the harness's shell and
  file tools, browser and computer control, MCP tools, the Cursor CLI's web search and fetch)
  passes policy, rules and an independent LLM judge before it runs, and fails closed. Risky actions
  wait for your approval unless your approval policy runs them; denied actions stay blocked under
  every policy, and agents can't reach the policy (the sidecar, `$DDL_HOME`, the daemon and the app
  are hard denies). With "Run everything", programs an agent writes and runs aren't inspected while
  they run. Web pages, emails, files and tool results may carry prompt injection: the gate and
  approvals are the control. Details: [safety](packages/agent/src/safety/README.md).
- **Computer use (macOS).** Every action in another app needs approval; the card and the rules see
  the app's real name and the element's real label, and the action runs against exactly the
  snapshot the approval described. Grants cover one app. Daily Do List, System Settings, password
  managers, authenticators, security prompts and the web UI are off-limits even with approval
  ([execution providers](packages/agent/src/execution/README.md)).
- **Secrets, MCP servers and execution.** API keys live outside the repository and are never
  logged; the hooks and CI scan every commit ([docs/CI.md](docs/CI.md#security-securityyml)). MCP
  servers you configure and the local execution provider run with your privileges: the safety gate
  and approvals are the primary control, not OS sandboxing, so only add servers you trust.

### In scope

Examples:

- bypassing the safety gate or approvals, or any tool that executes without the gate;
- prompt injection that leads to a risky action without approval;
- an agent changing the approval policy, or a denied action running under any policy;
- an agent operating a protected app, or an approval card that names a different app or element
  than the one acted on;
- getting past the daemon's (or the Cursor harness MCP bridge's) token, `Host` or `Origin` checks,
  or reading the vault or agent state from a web page;
- pairing without a valid code, guessing codes faster than the limits allow, using a revoked
  device's token or cookie, getting the master token onto a page served for a remote host, or using
  a browser's device cookie from anywhere but its own page;
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

- Keep the daemon on localhost. To reach it from your other devices, use a private network
  (`tailscale serve` to its loopback port) and add that name to `remote.hosts`. Never expose it on
  the public internet: no public tunnels (Tailscale Funnel), port forwards or public reverse
  proxies.
- Pair only devices you control: a pairing code is as good as a password for five minutes. Revoke a
  lost device right away (Settings → Devices, or `node dist/main.js revoke <device id>` on the
  machine running the daemon).
- Read approval cards before approving, especially payments and outgoing messages.
- Keep the approval policy at "Ask for risky actions" unless you have a reason to change it; "Run
  everything" lets agents spend money and send messages without asking.
- Grant computer use permissions only to the app that runs Daily Do List (Settings → Computer Use
  names it), and turn them off when you stop using computer use.
- Only configure MCP servers you trust, and give connectors least-privilege tokens.
- Keep `~/.daily-do-list` private. It holds the daemon token, your API keys, the sync token, the
  paired devices, the always-on machine's credential and agent state.
- If you run the sync service, serve it over HTTPS only, keep its database and backups private (it
  holds your notes), and rotate a vault's token (`vault rotate-token`) if a device is lost.

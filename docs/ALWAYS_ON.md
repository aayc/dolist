# Always-on agent: design

Status: design, not built. This document is the plan for running the agent on an always-on
machine instead of the laptop. The phases at the end are the build order; each one ships on its
own.

## Goal

Today the agent runs inside the daemon on the laptop, so it stops when the laptop sleeps: a
routine due at 7:30 waits until the lid opens, and nothing can be delegated from a phone. The goal
is an agent that is always available, on a machine the user controls, without giving up plain
files, local-first editing or the safety model.

## The shape: clients, one brain, hands

```
 laptop (Mac app / web)          phone (planned)
 vault folder + daemon           thin client
   │  notes: local, synced          │
   │  agent: relayed ───────┐       │
   │  hands: lent (opt-in) ─┼───┐   │
   ▼                        ▼   ▼   ▼
 ┌───────────────────── always-on machine (Linux VM) ─────────────────────┐
 │ daemon: vault copy · agent (orchestrator, harness, safety gate,         │
 │         approvals, threads, routines) · holds the agent lease           │
 │ hands:  shell · browser · virtual desktop                               │
 │ sync service (apps/sync)                                                │
 └───────────── reachable only over a private network (tailnet) ───────────┘
```

- **One brain per vault, on the always-on machine.** The daemon's agent side (orchestrator,
  harness, safety gate, approval broker, thread store, routines scheduler) runs there. The sync
  service's agent lease ([SYNC.md](./SYNC.md#the-agent-lease)) already guarantees one agent per
  vault; the always-on machine is simply the device that holds it.
- **Clients stay thin.** Web, macOS and the planned iPhone app speak the existing wire protocol
  (`packages/core/src/protocol.ts`) with a base URL and a token. Nothing in them assumes the
  agent is on the same machine.
- **Hands are wherever the effect has to happen.** By default the always-on machine's own shell,
  browser and virtual desktop. The laptop can lend its hands (its signed-in desktop apps, local
  files) while it is awake, and only when the user turns that on.
- **Notes stay local-first.** Every device keeps its folder and its daemon, so editing is instant,
  works offline and stays Obsidian-compatible. The always-on machine is one more synced device.

### Why the harness runs with the brain

- It is light (mostly model API calls). What it needs is to be awake, not the laptop's compute.
- The safety gate and approval broker must run in the same process as the agent loop (invariant 1:
  every tool call passes `beforeToolCall` before it executes). A network hop inside the gate adds
  failure modes that would all have to fail closed.
- Not in a browser tab: it would stop when the tab closes, and model keys would live in the page.
- One place for model credentials, logs and thread history.

### Rejected alternatives

- **Brain on the laptop, remote hands** (what the `cloud` execution provider stub describes): the
  laptop still has to be awake, which is the problem this solves. The stub may later serve
  disposable per-task sandboxes; it is not part of this plan.
- **One cloud daemon, no local daemons:** loses offline editing and the plain folder on each
  device (principle 3).
- **Clients talk to two daemons** (local for notes, remote for the agent): every client would need
  two endpoints and its own credential for the brain. The relay below keeps clients unchanged.

## The always-on machine

An Azure Linux VM (2 vCPU and 8 GB of memory is comfortable for Node, Chrome and a virtual
display). What works on Linux today: the daemon, both harnesses (Pi in process; the Cursor CLI is
installed and signed in on the VM), the shell, the browser (Playwright) and MCP connectors. What
doesn't: desktop control, which is macOS-only (JXA for the screen, `ddl-computer` for apps). Phase
4 adds a Linux desktop.

Setup principles:

- **No public inbound ports.** The VM has no public IP, or a network security group that denies
  all inbound traffic. Administration goes over the private network (for example Tailscale SSH).
- **Encrypted disk.** The VM holds the vault, the model credentials and the agent's browser
  profile (its signed-in sessions).
- **Separate accounts.** The agent's browser on the VM is signed in only to what the user gives
  it. A mistake lands on the agent's machine, not on the user's.

## Remote access

The daemon keeps binding `127.0.0.1`. A private overlay network (Tailscale, or any equivalent such
as WireGuard or Cloudflare Tunnel with Access) terminates TLS on the VM and forwards to the
loopback port, so the daemon is reachable only from the user's devices and never from the public
internet. The daemon knows nothing about the overlay; it sees a local proxy.

What changes in the daemon (`apps/daemon/src/security.ts`, `token.ts`, `routes/web.ts`):

- **Remote hosts are configured, not inferred.** `remote.hosts` lists the names the daemon answers
  to (for example the VM's tailnet name). Each adds an allowed `Host`, the `https://` Origin and a
  `wss://` entry in the page's `connect-src`. Everything else keeps getting `forbidden_host`.
- **Device tokens.** Each client gets its own token: random, 256-bit, stored hashed in `DDL_HOME`
  (never in the vault, so it never syncs), with a name, creation time, last use and revocation.
  Revoking one closes that device's WebSockets. The master token (`$DDL_HOME/daemon-token`) never
  leaves the machine.
- **Pairing.** A trusted client (a local one, or an already-paired device) asks for a pairing code:
  short, single-use, valid for a few minutes, rate-limited. The new device exchanges it for its
  device token. Settings lists paired devices and revokes them (web and Mac).
- **The page never embeds a token for a remote Host.** `index.html` gets the master token only when
  the request's Host is loopback, as today. For a remote Host it renders the pairing screen; after
  pairing, the browser keeps its device token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie
  scoped to the daemon's origin, accepted only together with an allowed Origin (so script on the
  page never holds a credential). Native clients keep sending bearer tokens.
- **The macOS app** gets "Connect to a daemon…": URL plus pairing code, token in the Keychain,
  `DaemonSupervisor` in attach-only mode (it never starts or stops a remote daemon).

This is a deliberate change to invariant 6 ("the daemon is local-only"): it becomes "local-only
unless remote hosts are configured, and then only through a private network with device tokens".
`AGENTS.md` changes with phase 1.

## The agent relay

Today a daemon that doesn't hold the agent lease shows no threads or approvals ("The agent is
running on <device>"). With the relay, it forwards agent routes and events to the lease holder, so
the laptop's app shows the always-on agent's threads, approvals, orchestrator chat and routines,
and the user approves from any device.

- **Which routes relay:** the agent's (threads, messages, approvals, orchestrator, routines,
  artifacts, execution status and frames). Notes, search and settings stay local.
- **How it finds the holder:** the lease records the holder's agent endpoint (its remote host).
  The two daemons pair once, like any device, and the relay uses that device token.
- **Offline:** when the holder can't be reached, the relay answers `agent_unavailable` and the UI
  shows the synced threads read-only (the sidecar already syncs, see [SYNC.md](./SYNC.md)).
- **Lease preference:** a device setting `agent.runHere`: `preferred` (the VM), `fallback` (take
  the lease only after the preferred holder has been gone for a while) or `never`. Today whoever
  asks first wins.

## Lending the laptop's hands

Some things exist only on the laptop: signed-in desktop apps (Slack, Messages, Obsidian), local
files. The laptop can lend its hands to the brain:

- **Outbound only.** The laptop daemon connects to the brain over the relay link and offers its
  execution provider (shell, browser, desktop, `ddl-computer` app control). The brain never needs
  to reach the laptop, and a sleeping laptop simply isn't available.
- **A remote `ExecutionProvider`** on the brain wraps that connection; a routing provider picks the
  machine per thread from what each one offers. Tools, prompts and safety rules don't change
  (principle 4, registries).
- **The gate runs on the brain, first.** The laptop runs only calls the gate allowed, and it keeps
  its own local checks: protected targets are still enforced by `ddl-computer` on the real process,
  and a local "Let the agent use this Mac" switch (off by default) refuses everything when off.
- **Approval cards and safety hints name the machine** ("Press Send in Slack on the MacBook").
- **Permissions** (Accessibility, Screen Recording) stay granted to the Mac app, which runs the
  laptop's daemon, as today.

## Linux desktop

For apps that have no API and run on Linux (or web apps that need a real screen):

- A virtual display (Xvfb) with a light window manager, input via XTest, screenshots of the
  display. A `LinuxComputerController` implements the same `ComputerController` contract as the
  macOS one, so the screen-level tools, safety rules (`surface: "computer"`) and frames work
  unchanged.
- A VNC server on the virtual display, reachable only over the private network, for the user to
  watch, sign the agent in to sites, or take over.
- App control through the Linux accessibility tree (AT-SPI) is possible later, the equivalent of
  `ddl-computer`; screen-level control plus the browser covers most needs first.

## Phases

Each phase ships on its own, with tests, docs and CI green.

1. **Remote access.** Remote hosts, device tokens, pairing (API, web pairing screen, Settings →
   Devices on web and Mac), the cookie for remote browsers, "Connect to a daemon…" in the Mac app,
   and a setup guide. Done when a second machine on the private network pairs and uses the full
   app, a revoked device is cut off immediately, and every existing security test still holds
   (plus a Host/Origin/token matrix for remote hosts).
2. **The always-on daemon.** A Linux bundle (`pnpm deploy` output, like the Mac app's), a systemd
   unit, a setup script, the sync service on the same VM, health and log rotation, and the lease
   preference. Done when the VM runs routines on schedule with the laptop asleep.
3. **The agent relay.** Done when the laptop's app shows and approves the VM agent's work,
   including the orchestrator chat and routines, and degrades to read-only when the VM is
   unreachable.
4. **Linux desktop.** `LinuxComputerController`, the virtual display, VNC for takeover. Done when
   the screen-level computer tools pass their contract tests on Linux with fakes, and a smoke test
   drives a real app on the VM.
5. **Lending the laptop's hands.** The remote execution provider, routing, the local switch, and
   machine names in approval cards. Done when a VM-run task operates a Mac app on the laptop with
   the same approvals as today, and nothing runs when the switch is off.
6. **The iPhone app** ([CROSS_PLATFORM.md](./CROSS_PLATFORM.md)), against the always-on daemon.

## Open questions

- Model credentials on the VM: the Cursor CLI signed in there, an OpenRouter key, or both.
- Lease handover mid-run: the new holder restores threads from the sidecar, but a run in flight on
  the old holder stops. Is resuming it worth building?
- Frames through the relay (up to 10 per second): forward as-is, or lower the rate for remote
  viewers.

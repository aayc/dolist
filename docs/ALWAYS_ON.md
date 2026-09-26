# Always-on agent: design

Status: phases 1 to 3 (remote access, the always-on daemon with its setup kit, the relay) and the
Settings below are built and on `main`, except where marked "not built yet"; next is verifying
them on the real VM. Phases 4 to 6 are design only. This document is the plan for running the
agent on an always-on machine, or on any device, chosen per device.

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

- **Brain on the laptop, remote hands** (a remote execution provider): the laptop still has to be
  awake, which is the problem this solves.
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

Setting one up: the [Linux setup kit](../deploy/linux/README.md) builds a bundle (daemon, web app,
sync service) and installs it with `setup.sh` as two hardened systemd services under their own
user, with the always-on placement and the tailnet name as remote host, and the
[Azure guide](../deploy/azure/README.md) creates an Arm64 VM (`Standard_D4ps_v6`) whose security
group closes every inbound port (it has a public IP for outbound traffic only, or none behind a
NAT gateway), with encryption at host, joined to the tailnet at first boot.

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
  `DaemonSupervisor` in attach-only mode (it never starts or stops a remote daemon). **Not built
  yet:** the app attaches to a daemon at another URL only with the local token (its "External"
  mode, for `pnpm dev`); it reaches the always-on machine through its own daemon's relay.

This is a deliberate change to invariant 6 ("the daemon is local-only"): it becomes "local-only
unless remote hosts are configured, and then only through a private network with device tokens".
`AGENTS.md` changes with phase 1.

### With Tailscale

On the machine running the daemon (placeholders: `vm-name.tailnet-name.ts.net`, port 7331):

1. `sudo tailscale serve --bg --https=443 http://127.0.0.1:7331`. Tailscale terminates TLS with the
   tailnet's certificate and keeps the original `Host`. Never `tailscale funnel`: that publishes
   the daemon on the internet.
2. `"remote": { "hosts": ["vm-name.tailnet-name.ts.net"] }` in `$DDL_HOME/config.json` (or
   `DDL_REMOTE_HOSTS`), then restart the daemon. Without it every request through the proxy gets
   `forbidden_host`; a proxy that rewrote the `Host` to loopback would be refused too.
3. `node dist/main.js pair` on that machine (as the daemon's user) prints a code; open
   `https://vm-name.tailnet-name.ts.net` on the new device, or enter it as the always-on machine's
   address, and type the code.

Details (credentials per client, the cookie rules, limits): [apps/daemon/README.md](../apps/daemon/README.md#remote-access-and-pairing)
and [SECURITY.md](../SECURITY.md).

## The agent relay

A daemon that doesn't hold the agent lease shows the holder's threads, approvals and task records
read-only from the synced sidecar ("The agent is running on <device>"). With the relay, a device
set to `always_on_machine` forwards agent routes and events to the always-on machine, so the
laptop's app shows the always-on agent's threads, approvals, orchestrator chat and routines, and
the user approves from any device. Details: [apps/daemon/README.md](../apps/daemon/README.md#the-agent-relay).

- **Which routes relay:** threads (the orchestrator's chat included) with their messages, cancel
  and retry; approvals and deciding them; artifacts; task records; routines (list, create, run,
  pause, resume); and the agent status, which keeps this device's placement and readiness. The
  machine's agent events come over one WebSocket (surface frames as they are; a client that can't
  keep up skips frames, as locally), and surface watches, thread reads and typing go the other
  way. Notes, search, settings, sync and device routes stay local.
- **Where it goes:** to the always-on machine named in the vault's settings
  (`remote.alwaysOnMachine`), with the credential this device got when it paired with it, like any
  device; the relay doesn't look the holder up in the lease. When the machine doesn't hold the
  agent itself (a device set to `this_device` took it over), the machine answers with its own
  read-only view, so the relaying device shows that work read-only and actions say where the agent
  runs.
- **Offline:** when the machine can't be reached, or this device isn't paired, the daemon itself
  serves the synced threads, approvals and records read-only (the sidecar already syncs, see
  [SYNC.md](./SYNC.md)), routine files stay editable, and agent actions answer
  `agent_unavailable` saying why. The relay reconnects by itself and resyncs its clients.

## Where the agent runs: a choice per device

Each device chooses where its agent runs, and the choice can change at any time. For example: a
personal laptop uses the always-on machine, a work laptop runs the agent itself, and the web app
and the phone use the always-on machine.

- **Placement is a device setting**, kept in that device's `DDL_HOME` (never synced, since each
  device chooses for itself):
  - `this_device`: run the agent here. While this device runs, it takes the agent over from the
    always-on machine.
  - `always_on_machine`: never run it here; relay to the always-on machine.
  - `always_on_host`: this is the always-on machine; it runs the agent whenever no device set to
    `this_device` is running.

  A device without sync is standalone and runs its own agent, as today. Without an always-on
  machine set up (or without sync), the agent is held on the device whatever it chose, and the
  choice applies again once both are set up.
- **One toggle:** a "Remote" switch (on: the always-on machine runs the orchestrator; off: this
  device does) sits in the agent panel's header on the web and the Mac, not only in Settings, and
  can be flipped at any time; the handover shows as it happens.
- **Handover uses the agent lease with a priority.** A `this_device` request outranks the
  always-on machine's: the sync service marks a takeover, the holder sees it on its next renewal,
  stops its agent, runs a sync pass and releases, and the requester starts from the synced state
  (about half a minute). When that device quits or sleeps, the always-on machine takes the lease
  back as today. Equal priorities keep first come, first served. A run in progress at handover
  stops on the old holder and resumes on the new one from its thread's journal (unless it stopped
  in the middle of an action that may or may not have happened: that one waits for the user).
- **Everything the agent needs to move syncs already**: notes, routine files, threads, artifacts,
  task records, approvals, routines state and settings (the sidecar, see [SYNC.md](./SYNC.md)).
  What stays with each machine is what belongs to it: connectors (`mcp.json`), API keys, the
  agent's browser logins, the harness login and macOS permissions. Settings shows each machine's
  readiness (harness signed in, model credential present, connectors connected, browser and
  desktop available), so moving the agent never fails silently.
- **The always-on machine's name and address are synced settings**, so every device knows it;
  each device still pairs once and keeps its own credential.
- **Fencing:** every lease grant has an increasing epoch, and the sync service refuses writes to
  the agent's sidecar files (threads, artifacts, `state/`) that don't carry the current one, so a
  device that lost the agent while offline can't overwrite the new holder's state when it
  reconnects.
- **The journal (phase 1 built, for threads):** thread state is append-only events that merge as
  a union (`state/journal/threads/`, under the fenced `state/`), side effects are journaled before
  and after they run (never re-run when uncertain), and a run resumes on the new machine instead of
  stopping ([docs/specs/agent-journal.md](./specs/agent-journal.md),
  [AGENT_SYSTEM.md](./AGENT_SYSTEM.md#the-journal-write-ahead-interrupted-steps-and-resuming)).
  Approvals and routines state follow in phase 2. Temporal was considered and rejected:
  a central server every device would depend on, histories outside the vault, and replay that
  needs control of the agent loop, which lives inside the harness.

## Settings

Everything needed lives in Settings, on the web and in the Mac app:

- **Agent location:** the Remote switch (on the VM: "this is the always-on machine"), where the
  agent runs right now, and this device's readiness.
- **Always-on machine:** its address (tailnet name), pairing with a code, and its status
  (reachable, version, where its agent runs, its readiness). Forgetting it drops this device's
  credential.
- **Sync:** the sync service's address, the vault, the vault token (write-only: never shown again)
  and the sync status.
- **Devices:** the devices paired with this daemon, a pairing code with the address to open, and
  revoking a device. A QR code for the phone is not built yet (`POST /api/pairing-codes` already
  returns the URL for one).
- **Remote access:** the names this daemon answers to (on the VM, its tailnet name).

Secrets (the vault token, device credentials) are stored `0600` in `DDL_HOME`, never in
`settings.json` (which syncs) and never returned by the API.

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
   Devices on web and Mac), the cookie for remote browsers, "Connect to a daemon…" in the Mac app
   (not built yet), and a setup guide. Done when a second machine on the private network pairs
   and uses the full app, a revoked device is cut off immediately, and every existing security
   test still holds (plus a Host/Origin/token matrix for remote hosts).
2. **The always-on daemon.** A Linux bundle (`pnpm deploy` output, like the Mac app's), systemd
   units, a setup kit (`deploy/linux`, `deploy/azure`), the sync service on the same VM, health
   and log rotation, and placement per device with lease priorities. Done when the VM runs
   routines on schedule with the laptop asleep, and a device set to `this_device` takes the agent
   over and hands it back.
3. **The agent relay.** Done when the laptop's app shows and approves the VM agent's work,
   including the orchestrator chat and routines, and degrades to read-only when the VM is
   unreachable. Settings (above) ships with phases 1 to 3.
4. **Linux desktop.** `LinuxComputerController`, the virtual display, VNC for takeover. Done when
   the screen-level computer tools pass their contract tests on Linux with fakes, and a smoke test
   drives a real app on the VM.
5. **Lending the laptop's hands.** The remote execution provider, routing, the local switch, and
   machine names in approval cards. Done when a VM-run task operates a Mac app on the laptop with
   the same approvals as today, and nothing runs when the switch is off.
6. **The iPhone app** ([CROSS_PLATFORM.md](./CROSS_PLATFORM.md)), against the always-on daemon.

## Open questions

- Model credentials on the VM: the Cursor CLI signed in there, an OpenRouter key, or both.
- Frames through the relay (up to 10 per second) are forwarded as they are; lowering the rate for
  remote viewers remains possible if links turn out slow.

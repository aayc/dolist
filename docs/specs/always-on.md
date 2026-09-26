# Spec: the agent anywhere — always-on machine, placement per device, pairing, relay, Settings

Status: built (`7ce1e9f`, `bbe8aff`); verifying it on the real VM is pending. Streams S0–S6 were
built in parallel and merged through `feat/always-on` (their scopes are in git history).

Where it is now:

- Design and the user's choices (placement per device, Tailscale only, no Azure management,
  Settings on the web and the Mac for all of it): [docs/ALWAYS_ON.md](../ALWAYS_ON.md).
- Wire: the schemas in `packages/contract/src/wire/remote.ts` and `settings.ts`, the generated
  reference in [docs/PROTOCOL.md](../PROTOCOL.md); the sync service's lease priorities, epochs,
  `AGENT_OWNED_PREFIXES` and `stale_lease` in `packages/core/src/sync-service.ts`. Shared
  validators (remote hosts, machine and sync URLs, device names, pairing codes) are in
  `packages/core/src/remote.ts`: use them, don't re-implement.
- Placement, lease priorities, handover and fencing: [docs/SYNC.md](../SYNC.md#the-agent-lease).
- Remote access, pairing, the relay: [apps/daemon/README.md](../../apps/daemon/README.md), the
  threat model in [SECURITY.md](../../SECURITY.md).
- The toggle, Settings and the pairing screen: [apps/web/README.md](../../apps/web/README.md#where-the-agent-runs-other-devices-pairing).
- The kit: [deploy/linux](../../deploy/linux/README.md) and [deploy/azure](../../deploy/azure/README.md).

Left to do: verify on the real VM what only it can (the `az` commands, the Tailscale login, and
that `tailscale serve` keeps the original `Host`); the Mac app's "Connect to a daemon…"; a QR code
on the pairing screens; browser pairing over https in the e2e harness (`test.fixme`: no TLS proxy
there).

# Spec: showing what the orchestrator is doing while you write

Status: built (`3f69ea2`).

Decided with the user (2026-09-25): the fast "triaging" badge on task lines is loved, but it only
appeared for checkbox tasks. When the user just writes, they want to see when the orchestrator
notices a line, works on it, and what it concluded, on any line, with the same wording and timings
on the web and the Mac, and nothing on the keystroke path.

Where it is now:

- Wire: `OrchestratorActivity` and the `orchestrator.activity` event in
  `packages/contract/src/wire/` (`domain.ts`, `events.ts`), `AgentStatusResponse.orchestrator` for
  a client joining mid-turn; reference in [PROTOCOL.md](../PROTOCOL.md).
- The runtime's phases, triggers and outcomes:
  [AGENT_SYSTEM.md](../AGENT_SYSTEM.md#what-it-is-doing-orchestrator-activity).
- Chips, the note header and the status bar (the contract the Mac follows):
  [apps/web/README.md](../../apps/web/README.md#what-the-orchestrator-is-doing-while-you-write).

# iPhone implementation streams

The complete acceptance scope is `apps/mobile/PLAN.md`; the durable execution ledger is
`apps/mobile/IMPLEMENTATION.md`. The user authorized parallel subagents on 2026-09-27.
The user later explicitly excluded all iPhone Vim work; preserve Mac/web Vim only.
Each stream uses an isolated branch, reports tests and remaining limitations, and never edits
`PROGRESS.md`. The integrator owns manifests spanning streams, app composition, CI, computer-use
and the final release checklist. No stream may operate the installed app or real vault.

| Stream | Owned scope | Initial exit gate |
| --- | --- | --- |
| Integrator | Mobile shell, native editor, connection UI, composition, CI and test tooling | Stable editor and real daemon connection with reviewed integrations |
| Backend | Workspace identity, expected-workspace mutation guard, atomic daily capture receipts; related contract, models/client and fixtures | Race/restart/lost-response tests; compatible web/Mac clients; generated protocol |
| Repository | MobileKit local markdown/base files, transactional SQLite outbox, recovery and reconciliation | Durable offline edits survive restart and cannot replay into another workspace; no lost newer edits |
| Agent core | Foundation agent state/store extraction and native iOS agent UI product | Existing Mac tests pass, iOS compiles, full thread/approval/routine/artifact flows reusable by shell |

Do not duplicate changes outside ownership. Communicate interface needs before editing another
stream's files. Each stream delivers a coherent commit for review and integration; a placeholder
is not an accepted feature. All test content is synthetic.

## Follow-up ownership

- Backend: fenced mutation receipts, durable notification catch-up, then receipt-aware AgentCore
  actions with a durable phone operation journal.
- Repository: metadata/composer/capture caches integrated; structural transactions, export/forget,
  then full thread/artifact/search/drawing persistence.
- Agent UI stream: AgentCore and touch drawing engine/advanced images integrated; full mobile
  settings and host management in an independent package. Remaining drawing parity stays tracked
  in the drawing package README.
- Integrator: real pairing, editor/store lifecycle, app composition, navigation/search, platform
  integration and CUA. Real TLS/Keychain, task→result/artifact, capture, offline relaunch and
  disjoint merge have passed focused CUA; the full release checklist remains open.

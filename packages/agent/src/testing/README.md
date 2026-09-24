# `@ddl/agent/testing` — the fake agent

A deterministic, free, instant stand-in for the model, plus everything needed to run the **real**
agent runtime on top of it: the `FakeBrain`, an HTTP fake of OpenRouter, fake "hands" (web,
browser, execution, MCP connectors) and `createFakeAgentRuntime` with test helpers.

```ts
import { createFakeAgentRuntime } from "@ddl/agent/testing";

const t = await createFakeAgentRuntime();                 // real runtime + real safety stack
await t.writeDailyNote(["- [ ] Book a table for two on Friday"]);
await t.approveNext();                                    // waits for the approval card, approves
await t.waitForStatus("Book a table for two on Friday", "done");
expect(t.audit.ungated()).toEqual([]);                    // every executed tool passed the gate
await t.stop();
```

Nothing here touches the network (only `127.0.0.1` servers it starts), real keys or real vaults.
Production code imports only the brain and the in-process script (they power
`DDL_AGENT_MODE=mock`); the HTTP server and helpers stay behind this subpath.

## The brain

`createFakeBrain(options?)` returns a `FakeBrain`. `brain.decide(request)` maps one model request
(system prompt, messages with tool calls and results, tools with JSON schemas, response format,
plugins) to one assistant turn (`reasoning`, `text`, `toolCalls`, `citations`). Its built-in
`policy()` is a pure function of the request; the role is detected from what the request offers:

| Role | Detected by | Behavior |
| --- | --- | --- |
| orchestrator | `spawn_subagent` / `post_comment` tools | Parses the event digest and triages every changed task and reply in **one** response: delegate (ack comment + `spawn_subagent` with the fewest capabilities that are available), answer (known facts, tips, conversions, arithmetic; otherwise `web_search` once), ask (vague tasks), ignore (chores, calls, exercise, harmful, deferred `[[Daily/…]]`). Edits: cosmetic → nothing; meaningful → `message_subagent`, falling back to a fresh spawn. A failed spawn is retried with the capabilities the error lists. Reports: no action. Ends its turn once every call has a result. |
| subagent | `finish_task` tool | One call per turn, re-derived from the transcript: `post_update` → research (`web_search`/`web_fetch`, else `browser_navigate` + `browser_snapshot`, else `bash` for code) → `write` a draft (files) → `create_artifact` → the irreversible step for book/buy/order/pay/email/send/reserve tasks (an MCP send tool, `browser_click` on the page's "Place order" button, or `mock_irreversible_action`) → `finish_task` (done; `needs_user` when blocked, denied or no tool can do the last step; `failed` after unrecovered errors). Invalid arguments are re-issued once, failing research sources are skipped, steering (replies, edits) is acknowledged and folded into the summary, a reply after finishing resumes it, "go ahead" after a denial retries the step. |
| judge | `json_schema` response format named `safety_verdict` | A verdict valid against `JUDGE_SCHEMA`: deny catastrophic or manipulative actions, require approval for real-world effects, allow reads. It is a stand-in: the rules in front of it are what keep tests safe. |
| web_search | `plugins: [{ id: "web" }]` | A short result list with `url_citation` annotations on example domains. |
| json / generic | anything else | Schema-valid structured output; otherwise calls the tools the prompt names (arguments from `name=value` pairs and backticks), then summarizes. |

Triage is keyword-based and tuned against `evals/datasets/triage.jsonl` (every case passes).
Phrasing is canonical by default; `createFakeBrain({ seed: 7 })` picks deterministic variations.
Token usage is characters / 4.

`createFakeBrain({ sandbox: true })` (mock mode and `pnpm dev:fake`) grants only web/files and calls
only thread, note, `web_search` and mock tools — never the browser, shell, computer, MCP or
`web_fetch` — so it stays harmless next to a real execution provider or connectors.

### Steering the brain in a test

```ts
brain.when("generic", { text: "pong" }, { times: 1 });              // a rule, before the policy
brain.when((req, info) => info.role === "subagent" && info.callsSinceUser.length === 0, turn);
brain.enqueue({ text: "exact turn" });                              // next request, any role
brain.enqueueFor("judge", { text: '{"decision":"deny",…}' });       // next judge request
brain.fail({ role: "orchestrator", message: "model down" });        // model error
brain.hang({ role: subagentFor("Plan the trip") });                 // never answers (abort/timeout)
brain.corruptToolArgs({ tool: "create_artifact", mode: "schema" }); // or "invalid-json", "wrong-type"
brain.unknownTool({ role: "subagent" });                            // calls `no_such_tool`
brain.decisions;                                                    // every decision with its request
```

Matchers are a role or `(request, info) => boolean`; target one task's subagent with a matcher
that looks for `Task: "<text>"` in its kickoff (see `subagentFor` in `test/scenarios/helpers.ts`).

## Two ways to drive it

| | `via: "scripted"` (default) | `via: "pi-http"` |
| --- | --- | --- |
| Harness | `ScriptedHarness` + `createFakeAgentScript(brain)` | the real Pi harness over HTTP |
| Model | the brain, in-process | `startFakeOpenRouter()` answering with the brain |
| One-shot LLM (judge, `web_search`) | `createFakeLlmClient(brain)` in live mode | the real `OpenRouterClient` against the fake |
| Speed | ~5–50 ms per scenario | ~50–250 ms per scenario |
| Use for | breadth: the scenario matrix, UI/daemon tests | the wire: streaming, retries, validation, aborts |

`mode: "mock"` (default for scripted) adds `mock_irreversible_action` for risky tasks and uses the
rules-only safety evaluator; `mode: "live"` adds the LLM judge and the real web tools (on a fake
network). `runtimeHarness: true` lets the runtime build its own harness exactly as in production
(mock: the built-in sandboxed brain; pi-http: Pi plus the key check, pointed at the fake).

The in-process script mirrors Pi: unknown tools and arguments that fail the tool's schema are
reported to the model without reaching the gate, tool errors read `Error: …`, gate blocks
`Blocked by safety policy: …`, and steering arrives at the next step.

## The fake OpenRouter

```ts
const server = await startFakeOpenRouter({ brain, chunkDelayMs: 0 });
server.baseUrl;   // http://127.0.0.1:<port>/api/v1 — use instead of https://openrouter.ai/api/v1
server.apiKey;    // "ddl-fake-key"; requests need `Authorization: Bearer <apiKey>`
server.requests;  // every request: headers, parsed body, brain request/turn, status, aborted…
```

Endpoints: `POST /chat/completions` (JSON, or SSE with role / reasoning / content deltas, tool-call
deltas with index, id, name and argument fragments, `finish_reason`, a usage chunk and `[DONE]`),
`GET /key` (200, or 401 `{ error: { message, code } }` after `setKeyValid(false)`), `GET /models`.

Faults, per request (`times`, `match`, `endpoint`):

```ts
server.inject({ kind: "status", status: 429, retryAfter: 0 }, { times: 2 });
server.inject({ kind: "status", status: 500, message: "upstream exploded" });
server.inject({ kind: "malformed-json" });              // broken body / broken SSE line
server.inject({ kind: "truncate", afterChunks: 3 });    // stream ends early, cleanly
server.inject({ kind: "abort", afterChunks: 2 });       // connection destroyed mid-stream
server.inject({ kind: "slow", chunkDelayMs: 25 }, { match: (r) => JSON.stringify(r.body).includes("finish_task") });
server.inject({ kind: "latency", ms: 100 });
server.inject({ kind: "hang" });
```

Run it standalone: `pnpm --filter @ddl/agent fake-openrouter [--port=8787] [--chunk-delay=15] [--no-sandbox] [--invalid-key]`.

## Fakes for the agent's hands

- `createFakeWeb(pages?)` / `createFakeWebTools({ llm, web })` — the real `web_fetch`/`web_search` on
  a fake network (generated articles, or pages you configure by URL; `web.fetched` records URLs).
- `createFakeExecution({ browser, shell, workspaceRoot })` — shell commands are recorded
  (`commands`); `browser: true` adds `createFakeBrowser()`, which serves an accessibility snapshot
  with refs to the real `browser_*` tools and records `actions` and irreversible `effects`
  ("Place order" clicked).
- `createFakeConnectors()` — `mail` (search_inbox, send_email) and `calendar` MCP servers built with
  the real `createMcpToolSpec`; writes are recorded in `effects`.

Assert on effects to prove irreversible actions only happen after approval.

## `createFakeAgentRuntime`

Options: `via`, `mode`, `storage`, `settings`, `brain`, `server` (instance or options), `faults`,
`runtimeHarness`, `execution`, `connectors`, `web`, `safetyPolicy`, `overrides`, `wordDelayMs`,
`advanceTimers`, `now`, `start`, `timeoutMs`. Defaults are fast: settle 20 ms, batching 5 ms,
three subagents.

Helpers: `writeDailyNote(lines, { day, external })`, `records()`, `record(text)`,
`statusesOf(text)`, `thread(text)`, `messages(text)`, `texts(text)`, `toolCalls(text)`,
`waitForStatus(text, status)`, `waitFor(check)`, `waitForApproval()`, `approveNext({ scope, task })`,
`denyNext(note)`, `replyInThread(text, message)`, `digests()`, `kickoffs()`, `idle()`,
`advance(ms)`, `restart({ crash })`, `stop()`; plus `events` (every runtime event, in order),
`audit` (gate records with verdicts, ToolSpec executions, the brain's calls) and the fakes.

Waits are event-driven with real-timer timeouts, so they also work under
`vi.useFakeTimers({ shouldAdvanceTime: true })`.

## Adding a scenario

Scenarios live in `packages/agent/test/scenarios/` (`helpers.ts` adds cleanup and assertions).

1. Create the runtime with `fakeRuntime(options)`, write the note, drive it with the helpers.
2. Assert records, status sequences (`expectStatuses`), thread messages, approvals, effects.
3. End with `expectAllGated(t)`.
4. Don't assume which of several tasks starts first (the digest's order can differ from the
   note's); target faults at one task with `subagentFor(text)`.
5. No sleeps over 50 ms: use waits, or fake timers for long timeouts (approval expiry, midnight).

Bugs found in modules owned elsewhere go into `reported-bugs.test.ts` as `it.fails` with a
`// BUG:` note. The brain's parsers are pinned to the prompt formats by round-trip tests
(`brain/digest.test.ts`, `brain/kickoff.test.ts`): when a prompt format changes, they tell you
which parser to update.

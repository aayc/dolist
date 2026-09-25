# @ddl/web

The browser client: React 19 + Vite. It talks to the daemon over REST + WebSocket, or to the
in-browser mock daemon with `?mock=1` (`&mockSpeed=4` speeds its agent up), which the e2e and perf
tests use.

```sh
pnpm --filter @ddl/web test        # unit tests (Vitest; happy-dom where a test needs a DOM)
pnpm --filter @ddl/web e2e         # Playwright, functional (real keyboard and mouse, mock daemon)
pnpm --filter @ddl/web e2e:perf    # Playwright, performance budgets (docs/PERFORMANCE.md)
```

Code map: `src/app` (startup, services, actions), `src/state` (zustand stores and pure reducers),
`src/features/*` (UI by feature), `src/commands` (the command registry and shortcuts), `src/api`
(clients and the mock). The rules for controls (tooltips, keycaps from the registry, the pointer)
are in `AGENTS.md`.

## The agent chat

`src/features/agent/`: `ChatTab` lists a thread's messages above the chat bar (`Composer`). What
follows is also the contract for the macOS agent panel: the pacing and the activity wording must
stay the same on both platforms, with the same table tests (`reveal.test.ts`,
`activity.test.ts`).

### Typing reveal

Agent text (`kind: "text"`, `role: "agent"`) that arrives while the thread is on screen, streamed
deltas or a whole new message, types out. Messages already there when the chat opens are history
and show at once; so does the part of a streaming message that had arrived. Your own messages
never animate.

- **Pacing** (`reveal.ts`): each animation frame, with `backlog` = grapheme clusters received but
  not shown and `dt` = seconds since the last frame (0 on a reveal's first frame), show
  `max(1, round(speed × dt))` more, never more than the backlog, at
  `speed = clamp(backlog / 1 s, 45, 3000)` per second. A steady stream trails what arrived by
  about a second; below 45/s it's one cluster per frame; long text catches up at up to 3000/s.
- **Grapheme clusters**, never code units: an emoji, a flag or a combining sequence is revealed
  whole, even when it arrives split across two deltas (the last pending cluster is re-segmented
  with the new text).
- A message that finishes streaming keeps revealing until caught up. A final text that doesn't
  extend what streamed (a repaired gap) keeps the shown part it still starts with.
- **Markdown renders progressively**, at most once per frame, block by block
  (`progressive-markdown.ts`): each frame re-lexes the revealed prefix and re-renders only the
  blocks that changed, usually the last. Incomplete syntax is left alone (`**bold` shows raw until
  its `**` is typed) except a trailing run of `*`, `_`, `~` or `` ` ``, held back until the next
  character so half of a closing `**` never flashes as italics. The final text then stays as
  rendered: no swap, no reflow.
- **Caret**: a 2 px accent bar at the reveal point while the text types out or streams. It's
  re-inserted each frame it moves, so it's solid while typing and blinks slowly while waiting.
- Nothing re-renders through React per character: `AgentTextView` paints the message's DOM from a
  store subscription, and one `requestAnimationFrame` loop (`lib/frame-loop.ts`) serves every
  message, stopping when nothing reveals.

### What the agent is doing

The live activity row ends the chat while the thread's agent is `queued` or running (`triaging`,
`working`, `waiting_approval`), first match wins (`deriveActivity`):

1. a pending approval for the thread: "Waiting for your approval" (the shield pulses; clicking
   the row scrolls to the card, which asks for attention again);
2. the latest running tool call: its activity label (below);
3. text streaming or typing out: no row (the caret says it);
4. otherwise "Thinking…" with three dots;
5. `queued`: "Waiting to start…".

The current step's elapsed time follows after 3 s ("· 12s", "· 1m 5s"), ticking once a second
while shown. Tool calls and approvals count from their `createdAt`; thinking and queued from when
the row showed them.

Activity labels (`activityLabel`):

| Tool | Label |
| --- | --- |
| `computer_open_app` | Opening {app}… (no app: "Opening an app…") |
| `computer_app_state`, `computer_screenshot` | Looking at {app}… (no app: "Looking at the screen…") |
| `computer_press` | Pressing “{element}” in {app}… (no element: "a control"; no app: no "in") |
| `computer_set_value`, `computer_type` | Typing in {app}… (no app: "Typing…") |
| `computer_key` | Pressing {combo} in {app}… (no combo: "a key"; no app: no "in") |
| `computer_click` | Clicking in {app}… (no app: "Clicking on the screen…") |
| `computer_scroll` | Scrolling in {app}… (no app: "Scrolling on the screen…") |
| `browser_navigate` | Opening {host}… (no host: "Opening a page…") |
| `browser_snapshot`, `browser_extract_text` | Reading the page… |
| other `browser_*` | Working in the browser… |
| `web_search` | Searching the web for “{query}”… (no query: "Searching the web…") |
| `web_fetch` | Reading {host}… (no host: "Reading a page…") |
| `read_note`, `search_notes` | Reading your notes… |
| `edit_note` | Editing your note… |
| `bash` | Running a command… |
| `read`, `grep`, `find`, `ls` | Looking through files… |
| `write`, `edit` | Writing files… |
| `mcp__{server}__{tool}` | Using {server}… |
| anything else | the call's `label`, else its name humanized (`post_update` → "Post update"), plus "…" |

Values come from the call's `input` (already redacted by the daemon; typed text is never shown).
Each is whitespace-collapsed, trimmed and clipped to 40 grapheme clusters (longer: the first 39 and
"…"); non-strings count as missing. A host is the URL's hostname without `www.` (`https://`
assumed when there's no scheme). A label ends with exactly one "…", even when a clipped value
already does.

Tool call rows spin while running and land on ✓, ✕ or a shield with a quick pop (only when seen
running). Consecutive calls that finished fine fold into one row, "Used 6 tools", that opens to
show them; running and failed calls stay visible, and so does a call that just finished while it's
the thread's last message, until the next step folds it in (`chat-items.ts`). The header's status
chip ripples while the agent works, and an approval card that arrives while you watch glows once.

### The chat bar

- The input grows with its text from one line to eight (the height animates), then scrolls.
- Enter sends; Shift+Enter adds a line (keycaps from the key table show while you type, and in
  the Send tooltip). Send is disabled while the input is empty.
- While the agent works, Stop sits beside Send: the `agent:stop` command (⌘. / Ctrl+.), which the
  thread header's Stop runs too. It applies while the panel shows a thread whose agent works.
- Replies are optimistic: the message shows at once, faded while sending; the input clears and
  keeps focus. A failed send stays in the chat with Retry and Discard. A pending reply is
  confirmed once the thread has more user messages with its text than when it was sent.
- Placeholder: "Reply to the agent…"; while an approval waits, "Approve above, or reply to change
  course…"; once the thread is done, failed or stopped, "Ask a follow-up…".

### Messages and scrolling

- Rows that arrive while you watch fade and slide in (180 ms); history doesn't.
- Hovering a message shows a copy button (the agent's markdown, or your text) and, for your
  messages, the time. Code blocks in agent messages get a copy button.
- At the bottom (within 48 px) the chat follows new content. Scrolled up, it never moves you: a
  "Jump to latest" pill counts the agent messages, approvals and artifacts that arrived since, and
  glides you down.

### Reduced motion

With `prefers-reduced-motion`, text appears as it arrives (no typing), and every indicator holds
still: no blinking caret, bouncing dots, pulses, ripples, pops or entrance slides; jumps are
instant.

### Tests

Unit: `reveal.test.ts` (pacing table, grapheme cuts), `activity.test.ts` (label table, priority),
`chat-items.test.ts` (grouping), `agent-text-view.test.ts` (typing, caret, idle frames, block
re-renders, reduced motion), `Composer.test.tsx`, `agent-commands.test.ts`,
`state/outbox-store.test.ts`. E2E: `e2e/chat.spec.ts` (reveal, history, activity and approval,
tool groups, chat bar, Stop and its shortcut, optimistic send and retry, jump to latest, copy,
reduced motion, an idle chat asking for no frames). In mock mode, `__ddlDebug.holdReplies({ ms,
fail })` delays or fails chat replies.

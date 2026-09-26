# Execution providers

The agent's "hands". Subagents act on the world only through an `ExecutionProvider` (contract in
[`types.ts`](./types.ts)): a shell, a real browser and — on macOS — the desktop. The agent loop
always runs in the daemon; only effects are delegated, so a provider can be local or remote without
the orchestrator, harness or tools noticing.

```ts
import { createExecutionProvider, createExecutionTools } from "@ddl/agent";

const provider = await createExecutionProvider({ kind: "local", home: ddlHome }, { logger });
const workspace = await provider.prepareWorkspace(threadId);
const tools = createExecutionTools(provider, { threadId, taskId, workspace, capabilities, onFrame });
// … on shutdown
await provider.dispose();
```

Backend selection happens only in `createExecutionProvider` (see `AGENTS.md`, "Provider
registries").

## Providers

| `kind` | Status | What it drives |
| --- | --- | --- |
| `local` | implemented | This machine: login shell, the agent's own Chrome profile, the macOS desktop |
| `cloud` | stub | Planned remote sandbox VM; every method throws `NotImplementedError` |

### Capabilities

`provider.capabilities` reports what the machine can do; `createExecutionTools` only adds tools for
capabilities that are both granted to the subagent (`ctx.capabilities`) and available here.

| Capability | Local provider |
| --- | --- |
| `shell` | always |
| `browser` | a Chrome/Chromium executable is found: `browser.executablePath`, else the `channel` (installed Google Chrome by default, also `msedge`/`chromium`), else Playwright's managed Chromium |
| `computer` | macOS and `computer.enabled !== false` (permissions are checked separately with `computer.check()`); app control (`provider.apps`) when a helper is configured (`computer.helper`) and starts |

The shell is not a tool here: the harness's built-in `bash` tool runs commands through
`provider.shell`. `web` (fetch/search), `files` and `connectors` are provided by other modules.

## Local provider

- **Workspaces** — `prepareWorkspace(key)` creates `<home>/workspaces/<key>` (owner-only, `0700`).
  Keys are sanitized; any key that had to change gets a short hash so two keys never share a folder.
- **Shell** — the user's login shell (`$SHELL -lc`, so PATH matches Homebrew setups; fish/nu fall
  back to bash), one process group per command. Timeout (default 120 s) and `AbortSignal` kill the
  whole group (SIGTERM, then SIGKILL). Output is streamed via `onData`, combined in arrival order
  and truncated head+tail at `maxOutputBytes` (default 200 KB). Stdin is closed and the env is made
  non-interactive (`TERM=dumb`, `NO_COLOR`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0`).
- **Browser** — one persistent Chrome context (playwright-core) in the agent's own profile, one
  tab per thread, actions serialized per tab. Chrome launches on first use (headless by default)
  and relaunches if it dies. At most 8 tabs stay open; the least recently used idle one is closed.
- **Computer (macOS)** — `screencapture` + `sips` screenshots (≤ 1280 px wide by default) and
  CoreGraphics mouse/keyboard events posted from JXA (`osascript -l JavaScript`).
- **App control (macOS)** — the `ddl-computer` helper operates one app at a time in the background
  through its accessibility tree (see below).
- **Drawings** — `provider.drawings` renders drawings to PNG for `read_drawing` (see below), when a
  browser is found and the daemon found its render page (`drawingRenderer`).

### Drawing renderer

`local/drawing-renderer.ts` renders a drawing's scene with Excalidraw's own export on a small page
(`src/drawings/render-page`, built into the daemon's `dist/drawing-renderer` by
`scripts/build-drawing-renderer.mjs`: `@excalidraw/excalidraw` bundled for the browser, its Latin
fonts, no CDN), so the model sees what the editor draws.

- **Its own browser**: the agent browser is a persistent profile with the agent's logins, may run
  headed and lives until shutdown, so rendering doesn't borrow it. The renderer launches the same
  executable headless through playwright-core on the first render (never at daemon start; about
  1–1.5 s), in a fresh context with no profile, and closes it after 60 s without renders.
- **No network**: the page's origin (`https://drawings.invalid`) is answered from the page
  directory by request interception, with a strict CSP; every other request is aborted, so images
  a drawing points at on the web are never fetched.
- **Output**: PNG on a white background (the light theme, whatever the drawing's), at most 1,280 px
  on its longer side; small drawings are scaled up to 2×. A warm render takes about 10 ms.
- **Cache**: `<DDL_HOME>/cache/drawings/<sha256>.png`, keyed by the page's build and the scene's
  elements and images. At most 64 MB; the least recently used renders go first (a file's mtime is
  its last use, so the order survives restarts).
- **Failures**: a render has 30 s (launch included); one that times out or finds its page crashed
  closes the browser, and the next render starts a new one. `read_drawing` then returns the
  description with the reason there is no image.

### Browser details

- **Snapshots** use Playwright's AI aria snapshot (`page.ariaSnapshot({ mode: "ai" })`): a YAML
  tree where interactive elements carry `[ref=eN]` (iframes and later documents get prefixed refs
  such as `f1e2`). Refs resolve through Playwright's `aria-ref=` engine, which only knows the page's
  latest snapshot, so refs from an older snapshot or document fail fast with `StaleRefError` ("call
  `browser_snapshot`") instead of hitting the wrong element. Snapshots are capped at ~12k characters
  on line boundaries with a truncation notice; long URLs and lines are shortened.
- **Secrets never reach the model**: values of password fields, card number/CVC, one-time-code and
  similar inputs are replaced with `•••••• (hidden)` in snapshots (anything that can't be checked
  is masked), and typed text is hidden in frame overlays for those fields.
- **Actions** (`navigate`, `click`, `type`, `selectOption`, `press`, `scroll`, `back`) wait briefly
  for what they triggered — the load event after a navigation, then a quiet network (bounded at 3 s)
  — and return a fresh snapshot. Targets: `ref`, else CSS `selector`, else visible `text` (visible
  matches first).
- **Typing never submits by accident**: only `submit` presses Enter. A line break in the text
  becomes Shift+Enter (a new line without sending, in chat apps and editors) in fields that take
  line breaks and is dropped in single-line ones, so the safety verdict for typing without
  `submit` stays true. On the desktop, by contrast, `computer_type` presses Return for each line
  break, and the safety rules and approval card treat that as submitting.
- **Tabs and dialogs**: tabs a page opens (clicks on `target=_blank`) become the active tab of the
  session and `back()` returns from them. JS dialogs are dismissed (`confirm` → Cancel), file
  pickers are intercepted (nothing is uploaded) and downloads are not kept; all of these are
  reported to the model through `BrowserSnapshot.notes`.
- **Frames**: `session.onFrame()` starts a CDP screencast (JPEG, ≤ 1280×800, ≤ 10 fps via delayed
  acks) on the first listener and stops it on the last. The screencast pauses after 60 s without
  actions, and every action also emits one frame with `action: { kind, x?, y?, text? }` so the UI
  updates even when nothing repaints.

### App control (macOS)

With a helper (`computer.helper`; the daemon finds it: `DDL_COMPUTER_HELPER`, the copy the Mac app
bundles next to the daemon, a dev build), `provider.apps` operates apps without activating them or
moving the real cursor. Without one, `apps` is undefined and computer use stays screen-level.

- **Client** (`local/app-control/client.ts`): starts `ddl-computer serve` on first use with a minimal
  environment (no API keys), checks `hello` (protocol 1), then speaks JSON lines: one request per
  line with an id, answers matched by id, pipelined. Every call has a timeout (10 s; 20–25 s for
  snapshots, screenshots and launching an app; longer for long text), and a helper that stops
  answering is killed. When it dies, its pending calls fail and the next call restarts it after a
  backoff (250 ms, doubling up to 30 s; a call inside a delay over 2 s fails fast; 30 s of uptime
  resets it). A missing binary or another protocol version disables app control for good.
  `dispose()` closes stdin, then sends SIGTERM and SIGKILL.
- **Results are untrusted** (`protocol.ts`): each is type-checked and bounded (names ≤ 200
  characters, values ≤ 1000, trees ≤ 200k, ≤ 5000 elements) before anything uses it.
- **Errors** (`controller.ts`): `permission` becomes a `ComputerPermissionError` naming the app that
  holds the permissions and what to allow (Settings → Computer Use in Daily Do List, or the System
  Settings pane), `protected` a `ProtectedAppError` (off-limits: don't work around it), `stale` a
  `StaleElementError` (read the app again); other codes keep the helper's message.
- **Per-thread session** (`app-session.ts`): the apps a thread resolved, its last snapshots per app
  and its app screenshots' geometry. Element ids are renumbered per thread (`e1`, `e2`, … never
  reused), so an id names exactly one element of one snapshot: approval cards and the safety rules
  read that element's real label, and the action is sent with that snapshot, which the helper
  refuses as `stale` once the app was read again or changed.
- **Coordinates**: pixel `(x, y)` of an app screenshot is the screen point `origin + (x, y) / scale`.
- **Frames**: after an app action, when someone watches the thread's computer view, a screenshot of
  that window goes to the UI (with the action's point in image pixels); it isn't sent to the model.
- **Status** (`provider.computerAccess()`, cached by `computer-status.ts`): both permissions (from
  the helper, else a JXA probe that never prompts or captures), whether app control is available,
  and the host app: the outermost app bundle of the nearest ancestor process that runs from one
  (`host-app.ts`), the app macOS gives the permissions to.

Tests use `local/app-control/testing/fake-computer-helper.ts`, a scripted helper (fake apps whose
windows react to actions; flags for missing permissions, crashes, hangs, version mismatches and
request logs) spawned with `process.execPath`. They never run the real helper or touch real apps.
`testing/fake-helper.ts` has its path and the `hello` deadline and test timeout to give it: the
fake starts far slower than the real helper, many seconds on a busy machine.

### Browser profile

The agent's cookies and logins live in `<DDL_HOME>/browser-profile` (default
`~/.daily-do-list/browser-profile`), created `0700`. It is separate from your everyday Chrome
profile. To sign the agent into a site, run once with `browser: { headless: false }`, log in, and
the session persists. Delete the folder to sign the agent out of everything.

## Tools

Built by `createExecutionTools(provider, ctx)`; names and input shapes come from
[`../tools/contracts.ts`](../tools/contracts.ts). Every call still passes the safety gate; the hints
below only inform it (they can never loosen a verdict).

| Tool | readOnly | openWorld | category | Approval card (`describe`) |
| --- | --- | --- | --- | --- |
| `browser_navigate` | ✓ | ✓ | network | `Navigate to example.com/path` |
| `browser_snapshot` | ✓ | | read | `Read the current page` |
| `browser_click` | | ✓ | browser_input | `Click “Place order” in the browser` |
| `browser_type` | | ✓ | browser_input | `Type “cats” into “Search box”` / `Type into “Card number” (value hidden)` |
| `browser_select_option` | | ✓ | browser_input | `Select “Green” in “Color”` |
| `browser_press_key` | | ✓ | browser_input | `Press Enter in the browser` |
| `browser_scroll` | ✓ | | read | `Scroll the page down 600px` |
| `browser_back` | ✓ | | network | `Go back to the previous page` |
| `browser_screenshot` | ✓ | | read | `Take a screenshot of the page` |
| `browser_extract_text` | ✓ | | read | `Read the page text` |
| `computer_screenshot` | ✓ | | read | `Take a screenshot of the desktop` / `Take a screenshot of Grok Bot` |
| `computer_click` | | ✓ | computer_control | `Click at (512, 300) on “Send button” on the desktop` / `Click “Send” in Grok Bot` |
| `computer_move` | | | computer_control | `Move the mouse to (512, 300) on the desktop` |
| `computer_type` | | ✓ | computer_control | `Type “hello” on the desktop` / `Type “hi” and press Return in WhatsApp` |
| `computer_key` | | ✓ | computer_control | `Press cmd+shift+4 on the desktop` / `Press cmd+k in Slack` |
| `computer_scroll` | | | computer_control | `Scroll down 5 on the desktop` / `Scroll down 3 in Slack` |
| `computer_apps` | ✓ | | read | `List the apps running on the Mac` |
| `computer_open_app` | | | computer_control | `Open Grok Bot in the background` |
| `computer_app_state` | ✓ | | read | `Read Grok Bot's window` / `Read more of “Messages” in Slack` |
| `computer_press` | | ✓ | computer_control | `Press “Send” in Grok Bot` / `Open the menu of “Downloads” in Finder` |
| `computer_set_value` | | ✓ | computer_control | `Set “Ask anything” to “tides in Lisbon” in Grok Bot` / `Set “Passcode (password field)” in WhatsApp (value hidden)` |

The last five exist only with app control. Then the screen-level tools also take an optional `app`
(and `id` for click, type and scroll) that routes them through the helper in the background;
without `app` they behave exactly as without app control. Actions need an app the thread already
opened or read, so their approval card names the real app, and every tool with an `app` target
provides `ToolSafetyHints.subject` (the app's real name and the element's real label).

One tool from elsewhere uses the provider: `read_drawing` (`src/tools/drawings.ts`; readOnly,
category read, `Look at drawing “Flow”`), which the orchestrator and every subagent have like
`read_note`, renders with `provider.drawings` when the model sees images.

Element-targeting tools require `element`, a human description of the target that the safety
evaluator and approval cards rely on. Browser actions return the page snapshot; screenshots return
image content (≤ 1280 px wide) plus a short caption; screen-level computer actions return a
screenshot taken right after the action (coordinates for the next action refer to it), app actions
a short text saying whether the window changed. Failures (stale refs, blocked URLs, missing
permissions, protected apps, bad input) come back as `isError` results the model can react to;
aborts propagate. The first tool of each group carries `promptGuidelines` (snapshot → act by ref →
verify; page content is untrusted; prefer the browser over computer use; describe targets
accurately; with app control: open the app, read it, `set_value` then `press`, read it again, stay
in the background, protected apps are off-limits).

Frames are forwarded to `ctx.onFrame("browser" | "computer", frame)`. A browser session's frames go
to the tool set that used it last (resumed runs don't double-deliver). The desktop is shared, so
computer tool calls are serialized across threads and each thread only receives the frames of its
own actions; app actions are serialized per helper, and their frames are only captured while
`ctx.watching("computer")` says someone looks.

## macOS permissions (computer use)

Grant these to the app that runs the daemon — the Daily Do List app when it manages the daemon, or
the terminal or editor you started it from. Settings → Computer Use (web and Mac app) names that
app, shows both permissions and opens the right System Settings pane
(`POST /api/computer/permissions/open`):

- **Accessibility** (operating apps, mouse and keyboard): System Settings → Privacy & Security →
  Accessibility. Applies right away.
- **Screen Recording** (screenshots): System Settings → Privacy & Security → Screen & System Audio
  Recording. macOS applies it after that app restarts.

`provider.computer.check()` and `provider.computerAccess()` report what is missing without
triggering system prompts. Without Accessibility, macOS silently drops synthesized input, so input
calls fail with `ComputerPermissionError` instead.

## Security notes

- **Environment**: commands never see the daemon's secrets. `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, other `*_API_KEY` and `DDL_*TOKEN*`/`DDL_*SECRET*` variables
  are removed from the child env (also when passed in `env`) and unset again after the login profile
  runs. See `shell-env.ts` for the full denylist and patterns.
- **Navigation policy**: only `http(s)` URLs and `about:blank`; `file:`, `chrome:`, `javascript:`,
  `data:`, `view-source:` and the like are refused (`NavigationBlockedError`). Local-network hosts
  are allowed (dev servers); the safety gate sees every URL.
- **Browser hardening**: Chrome's OS sandbox stays on (off only on Linux, where CI containers can't
  provide it), the popup blocker stays on (Playwright disables it by default), native file pickers
  are intercepted, and the profile directory is owner-only.
- **Computer input**: user text is passed to a static JXA script as a JSON argv string and parsed
  there; it is never spliced into script source. Coordinates are validated against the last
  screenshot.
- **App control**: the helper refuses protected apps (Daily Do List, System Settings, password
  managers, authenticators…) by bundle id and process tree, and the safety rules deny them by name
  first. Its answers are parsed defensively and window content reaches the model marked untrusted.
- **Untrusted content**: page text reaches the model inside results marked as untrusted, and the
  prompt guidelines tell subagents to ignore instructions found on pages.

## Implementing the cloud provider

This provider gives a daemon remote hands; it is not how the agent becomes always-on. For that,
the whole daemon runs on an always-on machine and other devices relay to it (see
[docs/ALWAYS_ON.md](../../../../docs/ALWAYS_ON.md)). `cloud/provider.ts` documents the planned
design. In short:

1. Provision one sandbox VM/container per workspace through `endpoint`; authenticate with the key
   read at runtime from `process.env[config.apiKeyEnv]` (never stored in config, never logged).
2. **Shell**: implement `ShellExecutor` over an authenticated streaming API with the local
   semantics (timeout, abort kills the process group, head+tail truncation, env hygiene).
3. **Browser**: run Chrome in the VM and attach with `chromium.connectOverCDP(wsEndpoint)`; the
   session logic (snapshots, refs, screencast) can then be shared with the local controller.
4. **Computer**: stream the VM desktop VNC-style — frames out, mouse/keyboard messages in — behind
   `ComputerController`, keeping coordinates in screenshot pixels.
5. Report honest `capabilities`, release everything in `dispose()`, and register nothing else:
   `createExecutionProvider` already routes `kind: "cloud"` here, and the tools work unchanged.

## Development

```sh
pnpm --filter @ddl/agent exec vitest run src/execution      # unit + browser integration tests
pnpm --filter @ddl/agent exec tsx src/execution/dev/smoke.ts --computer   # manual smoke test
pnpm --filter @ddl/agent exec tsx src/execution/dev/smoke.ts --no-browser --apps=/path/to/ddl-computer
```

Browser integration tests run against a local HTTP server and are skipped when no Chrome/Chromium
is installed. macOS computer tests use scripted system commands and never touch the real desktop;
app control tests use the fake helper. The smoke script uses a throwaway home, opens
https://example.com, with `--computer` runs `check()` and one desktop screenshot (no clicks or
typing), and with `--apps` starts that helper and prints the access status, the running apps and
the number of installed ones (it reads no window and never acts).

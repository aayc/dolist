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
| `computer` | macOS and `computer.enabled !== false` (permissions are checked separately with `computer.check()`) |

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
- **Tabs and dialogs**: tabs a page opens (clicks on `target=_blank`) become the active tab of the
  session and `back()` returns from them. JS dialogs are dismissed (`confirm` → Cancel), file
  pickers are intercepted (nothing is uploaded) and downloads are not kept; all of these are
  reported to the model through `BrowserSnapshot.notes`.
- **Frames**: `session.onFrame()` starts a CDP screencast (JPEG, ≤ 1280×800, ≤ 10 fps via delayed
  acks) on the first listener and stops it on the last. The screencast pauses after 60 s without
  actions, and every action also emits one frame with `action: { kind, x?, y?, text? }` so the UI
  updates even when nothing repaints.

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
| `computer_screenshot` | ✓ | | read | `Take a screenshot of the desktop` |
| `computer_click` | | ✓ | computer_control | `Click at (512, 300) on “Send button” on the desktop` |
| `computer_move` | | | computer_control | `Move the mouse to (512, 300) on the desktop` |
| `computer_type` | | ✓ | computer_control | `Type “hello” on the desktop` |
| `computer_key` | | ✓ | computer_control | `Press cmd+shift+4 on the desktop` |
| `computer_scroll` | | | computer_control | `Scroll down 5 on the desktop` |

Element-targeting tools require `element`, a human description of the target that the safety
evaluator and approval cards rely on. Browser actions return the page snapshot; screenshots return
image content (≤ 1280 px wide) plus a short caption; computer actions return a screenshot taken right
after the action (coordinates for the next action refer to it). Failures (stale refs, blocked URLs,
missing permissions, bad input) come back as `isError` results the model can react to; aborts
propagate. The first tool of each group carries `promptGuidelines` (snapshot → act by ref → verify;
page content is untrusted; prefer the browser over computer use; describe targets accurately).

Frames are forwarded to `ctx.onFrame("browser" | "computer", frame)`. A browser session's frames go
to the tool set that used it last (resumed runs don't double-deliver). The desktop is shared, so
computer tool calls are serialized across threads and each thread only receives the frames of its
own actions.

## macOS permissions (computer use)

Grant these to the app that runs the daemon — the terminal or editor you started it from, or the
Daily Do List app — then restart the daemon:

- **Accessibility** (mouse and keyboard): System Settings → Privacy & Security → Accessibility
- **Screen Recording** (screenshots): System Settings → Privacy & Security → Screen & System Audio
  Recording

`provider.computer.check()` reports what is missing without triggering system prompts. Without
Accessibility, macOS silently drops synthesized input, so input calls fail with
`ComputerPermissionError` instead.

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
- **Untrusted content**: page text reaches the model inside results marked as untrusted, and the
  prompt guidelines tell subagents to ignore instructions found on pages.

## Implementing the cloud provider

`cloud/provider.ts` documents the planned design. In short:

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
```

Browser integration tests run against a local HTTP server and are skipped when no Chrome/Chromium
is installed. macOS computer tests use scripted system commands and never touch the real desktop.
The smoke script uses a throwaway home, opens https://example.com, and with `--computer` runs
`check()` and one desktop screenshot (no clicks or typing).

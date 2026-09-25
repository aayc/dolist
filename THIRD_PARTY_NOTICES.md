# Third-party notices

Daily Do List is MIT licensed (see `LICENSE`). It builds on the open-source projects below. Code
that was adapted (not merely depended on) names its source in a header comment; the detailed
per-file tables live next to the code:

- `packages/connectors/NOTICE.md` — MCP connector pieces adapted from OpenClaw and Hermes Agent.
- `packages/agent/src/safety/NOTICE.md` — dangerous-command patterns and LLM-judge defenses
  adapted from Hermes Agent.
- `apps/macos/Packages/DailyDoListVim/NOTICE.md` — the Swift port of the web editor's vim mode
  (`vim.js` and its CodeMirror 6 adapter) and of the CodeMirror 6 behavior it relies on.

## Summary

| Project | How it is used | License |
| --- | --- | --- |
| [Pi](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`) | npm dependency: the agent harness behind `packages/agent/src/harness/pi` | MIT, © 2025 Mario Zechner |
| [OpenClaw](https://github.com/openclaw/openclaw) | Adapted: MCP tool filter, result projection, connect/dispose lifecycle (`packages/connectors`) | MIT, © 2026 OpenClaw Foundation |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Adapted: MCP tool naming/schema repair/redaction/backoff (`packages/connectors`); hardline + dangerous shell patterns and judge prompt defenses (`packages/agent/src/safety`) | MIT, © 2025 Nous Research |
| [CodeMirror vim mode](https://github.com/replit/codemirror-vim) (`@replit/codemirror-vim`, `@replit/codemirror-vim-core`) and [CodeMirror 6](https://codemirror.net) (`@codemirror/state`, `view`, `commands`, `search`, `language`, `@marijn/find-cluster-break`) | npm dependencies of the web editor; ported to Swift for the native apps (`apps/macos/Packages/DailyDoListVim`) | MIT, © 2018-2021 Marijn Haverbeke and others |

| [Excalidraw](https://github.com/excalidraw/excalidraw) (`@excalidraw/excalidraw`) and its fonts (Excalifont, Virgil, Xiaolai, Nunito, Lilita One, Comic Shanns, Cascadia Code, Liberation Sans, Assistant) | npm dependency of the web app: the drawing editor and renderer (`apps/web/src/features/drawings`). The build serves the fonts itself, with their notices in `assets/excalidraw-<version>/NOTICE.txt` (from `apps/web/excalidraw-notice.txt`) | MIT, © 2020 Excalidraw; fonts SIL OFL 1.1 (Comic Shanns MIT) |

All other dependencies are installed from npm under their own licenses (see each package in
`node_modules` or `pnpm licenses list`).

## License texts

### Pi

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### OpenClaw

```
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Hermes Agent

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### CodeMirror and its vim mode

`@replit/codemirror-vim`, `@replit/codemirror-vim-core` and the `@codemirror/*` packages carry this
license (`@marijn/find-cluster-break`: the same text, Copyright (C) 2024 by Marijn Haverbeke).

```
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

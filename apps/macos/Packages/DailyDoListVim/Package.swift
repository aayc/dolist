// swift-tools-version: 6.0
import PackageDescription

// Vim mode for the native editors: a faithful Swift port of vim.js (@replit/codemirror-vim-core
// 0.1.0, MIT, see NOTICE.md) behind a small editor protocol, plus VimTextBuffer, an in-memory
// editor with the semantics of the CodeMirror 6 adapter the web app uses. Foundation only; the
// tests replay the web vectors (packages/editor/test/vim/vectors.jsonl, read from the source tree).
// DailyDoListVimTestSupport replays those vectors against any host (the Mac editor's tests use it).
let package = Package(
  name: "DailyDoListVim",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListVim", targets: ["DailyDoListVim"]),
    .library(name: "DailyDoListVimTestSupport", targets: ["DailyDoListVimTestSupport"]),
  ],
  targets: [
    .target(name: "DailyDoListVim"),
    .target(name: "DailyDoListVimTestSupport", dependencies: ["DailyDoListVim"]),
    .testTarget(
      name: "DailyDoListVimTests", dependencies: ["DailyDoListVim", "DailyDoListVimTestSupport"]),
  ]
)

// swift-tools-version: 6.0
import PackageDescription

// Native markdown editor (AppKit/TextKit): Obsidian-style styling and live preview, clickable task
// checkboxes, agent badges, list editing commands, and vim mode (DailyDoListVim drives the text
// view through `VimEditor`). The tests replay the web app's vim vectors through the real editor.
let package = Package(
  name: "DailyDoListEditor",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListEditor", targets: ["DailyDoListEditor"])
  ],
  dependencies: [
    .package(path: "../DailyDoListVim")
  ],
  targets: [
    .target(
      name: "DailyDoListEditor",
      dependencies: [.product(name: "DailyDoListVim", package: "DailyDoListVim")]),
    .testTarget(
      name: "DailyDoListEditorTests",
      dependencies: [
        "DailyDoListEditor",
        .product(name: "DailyDoListVim", package: "DailyDoListVim"),
        .product(name: "DailyDoListVimTestSupport", package: "DailyDoListVim"),
      ]),
  ]
)

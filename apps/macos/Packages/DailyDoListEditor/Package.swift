// swift-tools-version: 6.0
import PackageDescription

// Native markdown editor (AppKit/TextKit): Obsidian-style styling and live preview, clickable task
// checkboxes, agent badges, list editing commands, drawings embedded in notes (DailyDoListDrawing
// draws and edits them), and vim mode (DailyDoListVim drives the text view through `VimEditor`).
// The tests replay the web app's vim vectors through the real editor.
let package = Package(
  name: "DailyDoListEditor",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListEditor", targets: ["DailyDoListEditor"]),
    .library(name: "DailyDoListEditorCore", targets: ["DailyDoListEditorCore"]),
    .library(name: "DailyDoListMobileEditor", targets: ["DailyDoListMobileEditor"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListDomain"),
    .package(path: "../DailyDoListVim"),
    .package(path: "../DailyDoListUI"),
    .package(path: "../DailyDoListDrawing"),
  ],
  targets: [
    .target(name: "DailyDoListEditorCore", dependencies: ["DailyDoListDomain"]),
    .target(
      name: "DailyDoListMobileEditor",
      dependencies: ["DailyDoListEditorCore", "DailyDoListVim", "DailyDoListDomain"]),
    .target(
      name: "DailyDoListEditor",
      dependencies: [
        "DailyDoListEditorCore",
        .product(name: "DailyDoListVim", package: "DailyDoListVim"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
        .product(name: "DailyDoListDrawing", package: "DailyDoListDrawing"),
      ]),
    .testTarget(
      name: "DailyDoListEditorTests",
      dependencies: [
        "DailyDoListEditorCore",
        "DailyDoListEditor",
        .product(name: "DailyDoListVim", package: "DailyDoListVim"),
        .product(name: "DailyDoListVimTestSupport", package: "DailyDoListVim"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
        .product(name: "DailyDoListUITestSupport", package: "DailyDoListUI"),
        .product(name: "DailyDoListDrawing", package: "DailyDoListDrawing"),
      ]),
  ]
)

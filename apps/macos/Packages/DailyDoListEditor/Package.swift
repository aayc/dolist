// swift-tools-version: 6.0
import PackageDescription

// Native markdown editor (AppKit/TextKit): Obsidian-style styling and live preview, clickable task
// checkboxes, agent badges, list editing commands. No dependency on the other packages.
let package = Package(
  name: "DailyDoListEditor",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListEditor", targets: ["DailyDoListEditor"]),
  ],
  targets: [
    .target(name: "DailyDoListEditor"),
    .testTarget(name: "DailyDoListEditorTests", dependencies: ["DailyDoListEditor"]),
  ]
)

// swift-tools-version: 6.0
import PackageDescription

// UI pieces every AppKit/SwiftUI package of the app shares: the palette (`Theme`), tooltips (one
// animated panel for the whole app, with keycaps), the keycap view, the pointing hand and the
// chrome button styles. The shell, the agent UI and the editor use it; it depends on nothing.
// DailyDoListUITestSupport lets their tests find tooltips, draw them into snapshots and tell a
// snapshot from a blank one.
let package = Package(
  name: "DailyDoListUI",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListUI", targets: ["DailyDoListUI"]),
    .library(name: "DailyDoListUITestSupport", targets: ["DailyDoListUITestSupport"]),
  ],
  targets: [
    .target(name: "DailyDoListUI"),
    .target(name: "DailyDoListUITestSupport", dependencies: ["DailyDoListUI"]),
    .testTarget(
      name: "DailyDoListUITests", dependencies: ["DailyDoListUI", "DailyDoListUITestSupport"]),
  ]
)

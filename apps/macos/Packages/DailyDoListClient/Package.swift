// swift-tools-version: 6.0
import PackageDescription

// REST + WebSocket client for the local daemon. Foundation only (reusable on iOS).
// DailyDoListClientTestSupport has the scriptable fake daemon the agent and app tests use.
let package = Package(
  name: "DailyDoListClient",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListClient", targets: ["DailyDoListClient"]),
    .library(name: "DailyDoListClientTestSupport", targets: ["DailyDoListClientTestSupport"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListModels"),
    .package(path: "../DailyDoListDomain"),
  ],
  targets: [
    .target(name: "DailyDoListClient", dependencies: ["DailyDoListModels", "DailyDoListDomain"]),
    .target(
      name: "DailyDoListClientTestSupport",
      dependencies: ["DailyDoListClient", "DailyDoListModels"]),
    .testTarget(
      name: "DailyDoListClientTests",
      dependencies: ["DailyDoListClient", "DailyDoListClientTestSupport"]),
  ]
)

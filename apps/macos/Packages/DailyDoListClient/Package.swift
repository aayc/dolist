// swift-tools-version: 6.0
import PackageDescription

// REST + WebSocket client for the local daemon. Foundation only (reusable on iOS).
let package = Package(
  name: "DailyDoListClient",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListClient", targets: ["DailyDoListClient"])
  ],
  dependencies: [
    .package(path: "../DailyDoListModels")
  ],
  targets: [
    .target(name: "DailyDoListClient", dependencies: ["DailyDoListModels"]),
    .testTarget(name: "DailyDoListClientTests", dependencies: ["DailyDoListClient"]),
  ]
)

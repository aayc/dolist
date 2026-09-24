// swift-tools-version: 6.0
import PackageDescription

// Agent state (records, threads, approvals, status) and the agent UI: inbox, thread view with
// approval cards, artifacts and live surfaces, notifications, menu bar content.
let package = Package(
  name: "DailyDoListAgent",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListAgent", targets: ["DailyDoListAgent"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListModels"),
    .package(path: "../DailyDoListClient"),
  ],
  targets: [
    .target(
      name: "DailyDoListAgent",
      dependencies: [
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
      ]
    ),
    .testTarget(
      name: "DailyDoListAgentTests",
      dependencies: [
        "DailyDoListAgent",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
      ]
    ),
  ]
)

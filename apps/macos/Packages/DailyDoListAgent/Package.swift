// swift-tools-version: 6.0
import PackageDescription

// Agent state (records, threads, approvals, status) and the agent UI: inbox, thread view with
// approval cards, artifacts and live surfaces, notifications, menu bar content.
// DailyDoListAgentTestSupport has the synthetic agent data (SampleData) the tests render.
let package = Package(
  name: "DailyDoListAgent",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListAgent", targets: ["DailyDoListAgent"]),
    .library(name: "DailyDoListAgentTestSupport", targets: ["DailyDoListAgentTestSupport"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListModels"),
    .package(path: "../DailyDoListClient"),
    .package(path: "../DailyDoListUI"),
  ],
  targets: [
    .target(
      name: "DailyDoListAgent",
      dependencies: [
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
      ]
    ),
    .target(
      name: "DailyDoListAgentTestSupport",
      dependencies: [
        "DailyDoListAgent",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListClientTestSupport", package: "DailyDoListClient"),
      ]
    ),
    .testTarget(
      name: "DailyDoListAgentTests",
      dependencies: [
        "DailyDoListAgent",
        "DailyDoListAgentTestSupport",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListClientTestSupport", package: "DailyDoListClient"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
        .product(name: "DailyDoListUITestSupport", package: "DailyDoListUI"),
      ]
    ),
  ]
)

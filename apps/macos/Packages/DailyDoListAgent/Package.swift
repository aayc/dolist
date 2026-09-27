// swift-tools-version: 6.0
import PackageDescription

// AgentCore owns portable state and actions. The macOS and iPhone products render that same
// state through platform adapters; no image or window framework enters the core.
// DailyDoListAgentTestSupport has the synthetic agent data (SampleData) the tests render.
let package = Package(
  name: "DailyDoListAgent",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListAgentCore", targets: ["DailyDoListAgentCore"]),
    .library(name: "DailyDoListMobileAgent", targets: ["DailyDoListMobileAgent"]),
    .library(name: "DailyDoListAgent", targets: ["DailyDoListAgent"]),
    .library(name: "DailyDoListAgentTestSupport", targets: ["DailyDoListAgentTestSupport"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListModels"),
    .package(path: "../DailyDoListDomain"),
    .package(path: "../DailyDoListClient"),
    .package(path: "../DailyDoListUI"),
  ],
  targets: [
    .target(
      name: "DailyDoListAgentCore",
      dependencies: [
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListDomain", package: "DailyDoListDomain"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
      ]
    ),
    .target(
      name: "DailyDoListMobileAgent",
      dependencies: [
        "DailyDoListAgentCore",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListDomain", package: "DailyDoListDomain"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
      ]
    ),
    .target(
      name: "DailyDoListAgent",
      dependencies: [
        "DailyDoListAgentCore",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListDomain", package: "DailyDoListDomain"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
      ]
    ),
    .target(
      name: "DailyDoListAgentTestSupport",
      dependencies: [
        "DailyDoListAgentCore",
        "DailyDoListAgent",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListClientTestSupport", package: "DailyDoListClient"),
      ]
    ),
    .testTarget(
      name: "DailyDoListAgentTests",
      dependencies: [
        "DailyDoListAgentCore",
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

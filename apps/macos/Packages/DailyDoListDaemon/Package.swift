// swift-tools-version: 6.0
import PackageDescription

// Starts, supervises and stops the local Node daemon (or attaches to one that is already running).
let package = Package(
  name: "DailyDoListDaemon",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListDaemon", targets: ["DailyDoListDaemon"])
  ],
  dependencies: [
    .package(path: "../DailyDoListModels")
  ],
  targets: [
    .target(
      name: "DailyDoListDaemon",
      dependencies: [.product(name: "DailyDoListModels", package: "DailyDoListModels")]),
    .testTarget(
      name: "DailyDoListDaemonTests",
      dependencies: [
        "DailyDoListDaemon", .product(name: "DailyDoListModels", package: "DailyDoListModels"),
      ],
      // Scripts run by the real-process tests, located through #filePath.
      exclude: ["Fixtures"]
    ),
  ]
)

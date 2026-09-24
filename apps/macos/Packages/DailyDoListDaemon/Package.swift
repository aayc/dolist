// swift-tools-version: 6.0
import PackageDescription

// Starts, supervises and stops the local Node daemon (or attaches to one that is already running).
let package = Package(
  name: "DailyDoListDaemon",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListDaemon", targets: ["DailyDoListDaemon"]),
  ],
  targets: [
    .target(name: "DailyDoListDaemon"),
    .testTarget(name: "DailyDoListDaemonTests", dependencies: ["DailyDoListDaemon"]),
  ]
)

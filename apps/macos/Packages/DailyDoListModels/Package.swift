// swift-tools-version: 6.0
import PackageDescription

// Wire models shared by every Swift client (macOS today, iOS later), and where the daemon keeps
// its token and listens (DaemonHome, for the client and the supervisor). Foundation only.
let package = Package(
  name: "DailyDoListModels",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListModels", targets: ["DailyDoListModels"])
  ],
  targets: [
    .target(name: "DailyDoListModels"),
    .testTarget(name: "DailyDoListModelsTests", dependencies: ["DailyDoListModels"]),
  ]
)

// swift-tools-version: 6.0
import PackageDescription

// End-to-end tests of the macOS packages against the real daemon: DaemonSupervisor launches
// apps/daemon/dist/main.js (mock agent, temporary DDL_HOME and vault, a free port) and the tests
// drive it through HTTPDaemonClient. Run with `apps/macos/scripts/test.sh integration`; skipped
// (with a message) when Node.js 24.4+ or the built daemon is missing.
let package = Package(
  name: "DailyDoListIntegrationTests",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(path: "../Packages/DailyDoListModels"),
    .package(path: "../Packages/DailyDoListClient"),
    .package(path: "../Packages/DailyDoListDaemon"),
  ],
  targets: [
    .testTarget(
      name: "DailyDoListIntegrationTests",
      dependencies: [
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListDaemon", package: "DailyDoListDaemon"),
      ]
    )
  ]
)

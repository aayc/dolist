// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DailyDoListMobileIntegration",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListMobileIntegration", targets: ["DailyDoListMobileIntegration"])
  ],
  dependencies: [
    .package(path: "../DailyDoListMobileKit"),
    .package(path: "../../../macos/Packages/DailyDoListClient"),
    .package(path: "../../../macos/Packages/DailyDoListModels"),
  ],
  targets: [
    .target(
      name: "DailyDoListMobileIntegration",
      dependencies: ["DailyDoListMobileKit", "DailyDoListClient", "DailyDoListModels"]),
    .testTarget(
      name: "DailyDoListMobileIntegrationTests", dependencies: ["DailyDoListMobileIntegration"]),
  ]
)

// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DailyDoListMobileKit",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [.library(name: "DailyDoListMobileKit", targets: ["DailyDoListMobileKit"])],
  dependencies: [
    .package(path: "../../../macos/Packages/DailyDoListClient"),
    .package(path: "../../../macos/Packages/DailyDoListDomain"),
    .package(path: "../../../macos/Packages/DailyDoListModels"),
  ],
  targets: [
    .target(
      name: "DailyDoListMobileKit",
      dependencies: ["DailyDoListClient", "DailyDoListDomain", "DailyDoListModels"],
      linkerSettings: [.linkedLibrary("sqlite3")]),
    .testTarget(
      name: "DailyDoListMobileKitTests",
      dependencies: [
        "DailyDoListMobileKit",
        .product(name: "DailyDoListClientTestSupport", package: "DailyDoListClient"),
      ]),
  ]
)

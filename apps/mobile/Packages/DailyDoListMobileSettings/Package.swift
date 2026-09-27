// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DailyDoListMobileSettings",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "DailyDoListMobileSettings", targets: ["DailyDoListMobileSettings"])],
  dependencies: [
    .package(path: "../../../macos/Packages/DailyDoListClient"),
    .package(path: "../../../macos/Packages/DailyDoListModels"),
    .package(path: "../../../macos/Packages/DailyDoListDomain"),
  ],
  targets: [
    .target(
      name: "DailyDoListMobileSettings",
      dependencies: ["DailyDoListClient", "DailyDoListModels", "DailyDoListDomain"]),
    .testTarget(
      name: "DailyDoListMobileSettingsTests",
      dependencies: [
        "DailyDoListMobileSettings",
        .product(name: "DailyDoListClientTestSupport", package: "DailyDoListClient"),
      ]),
  ]
)

// swift-tools-version: 6.0
import PackageDescription

// Daily Do List for macOS: a native SwiftUI/AppKit client of the local daemon.
// Modules live in Packages/ (each builds and tests on its own); this package is the app shell.
let package = Package(
  name: "DailyDoListMac",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "DailyDoList", targets: ["DailyDoList"])
  ],
  dependencies: [
    .package(path: "Packages/DailyDoListModels"),
    .package(path: "Packages/DailyDoListClient"),
    .package(path: "Packages/DailyDoListDomain"),
    .package(path: "Packages/DailyDoListDaemon"),
    .package(path: "Packages/DailyDoListEditor"),
    .package(path: "Packages/DailyDoListVim"),
    .package(path: "Packages/DailyDoListAgent"),
    .package(path: "Packages/DailyDoListUI"),
  ],
  targets: [
    .target(
      name: "DailyDoListApp",
      dependencies: [
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
        .product(name: "DailyDoListClient", package: "DailyDoListClient"),
        .product(name: "DailyDoListDomain", package: "DailyDoListDomain"),
        .product(name: "DailyDoListDaemon", package: "DailyDoListDaemon"),
        .product(name: "DailyDoListEditor", package: "DailyDoListEditor"),
        .product(name: "DailyDoListVim", package: "DailyDoListVim"),
        .product(name: "DailyDoListAgent", package: "DailyDoListAgent"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
      ]
    ),
    .executableTarget(name: "DailyDoList", dependencies: ["DailyDoListApp"]),
    .testTarget(
      name: "DailyDoListAppTests",
      dependencies: [
        "DailyDoListApp", .product(name: "DailyDoListVim", package: "DailyDoListVim"),
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
        .product(name: "DailyDoListUITestSupport", package: "DailyDoListUI"),
      ]),
  ]
)

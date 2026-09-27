// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DailyDoListWorkspaceCore", platforms: [.macOS(.v14), .iOS(.v17)],
  products: [.library(name: "DailyDoListWorkspaceCore", targets: ["DailyDoListWorkspaceCore"])],
  dependencies: [.package(path: "../DailyDoListDomain"), .package(path: "../DailyDoListModels")],
  targets: [
    .target(
      name: "DailyDoListWorkspaceCore",
      dependencies: [
        .product(name: "DailyDoListDomain", package: "DailyDoListDomain"),
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
      ]),
    .testTarget(name: "DailyDoListWorkspaceCoreTests", dependencies: ["DailyDoListWorkspaceCore"]),
  ])

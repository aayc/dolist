// swift-tools-version: 6.0
import PackageDescription

// The scene codec, shared editor/renderer, and platform canvases build independently. The iPhone
// canvas measures imports with the daemon's own request codec (Models).
let package = Package(
  name: "DailyDoListDrawing",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListDrawingModel", targets: ["DailyDoListDrawingModel"]),
    .library(name: "DailyDoListDrawing", targets: ["DailyDoListDrawing"]),
    .library(name: "DailyDoListDrawingCore", targets: ["DailyDoListDrawingCore"]),
    .library(name: "DailyDoListMobileDrawing", targets: ["DailyDoListMobileDrawing"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListUI"), .package(path: "../DailyDoListModels"),
  ],
  targets: [
    .target(name: "DailyDoListDrawingModel"),
    .target(
      name: "DailyDoListDrawingCore", dependencies: ["DailyDoListDrawingModel"],
      resources: [.copy("Resources/Fonts")]),
    .target(
      name: "DailyDoListMobileDrawing",
      dependencies: [
        "DailyDoListDrawingCore",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
      ]),
    .target(
      name: "DailyDoListDrawing",
      dependencies: [
        "DailyDoListDrawingCore",
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
      ]),
    .testTarget(
      name: "DailyDoListMobileDrawingTests",
      dependencies: [
        "DailyDoListMobileDrawing",
        .product(name: "DailyDoListModels", package: "DailyDoListModels"),
      ]),
    .testTarget(
      name: "DailyDoListDrawingTests",
      dependencies: [
        "DailyDoListDrawingModel", "DailyDoListDrawingCore", "DailyDoListDrawing",
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
        .product(name: "DailyDoListUITestSupport", package: "DailyDoListUI"),
      ],
      exclude: ["fixtures"]),
  ]
)

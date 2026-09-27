// swift-tools-version: 6.0
import PackageDescription

// The scene codec, shared editor/renderer, and platform canvases build independently.
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
    .package(path: "../DailyDoListUI")
  ],
  targets: [
    .target(name: "DailyDoListDrawingModel"),
    .target(
      name: "DailyDoListDrawingCore", dependencies: ["DailyDoListDrawingModel"],
      resources: [.copy("Resources/Fonts")]),
    .target(name: "DailyDoListMobileDrawing", dependencies: ["DailyDoListDrawingCore"]),
    .target(
      name: "DailyDoListDrawing",
      dependencies: [
        "DailyDoListDrawingCore",
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
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
